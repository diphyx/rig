import { isArray, isFunction, isObject, isString, tryit } from "radash";

import type { Context } from "./context.js";
import { Reason, Slot } from "./enums.js";
import { NAME } from "./parse.js";
import { Refusal } from "./refusal.js";
import { expandRule } from "./rules.js";
import type { Known } from "./store.js";
import type { Kind, KindWorker, Machine, RigConfig, Worker } from "./types.js";

const CALLS = ["check", "setup", "add", "drop", "spent"] as const;

/* The config's workers, or none when they are not a list; §5 refuses that. */
function workersOf(config: RigConfig): Worker[] {
    return isArray(config.workers) ? config.workers : [];
}

/** §22.1: each worker's `open`, when it has one; a throw is a refusal. */
export async function openWorkers(config: RigConfig): Promise<void> {
    for (const worker of workersOf(config)) {
        if (worker.open !== undefined) {
            if (!isFunction(worker.open)) {
                throw new Refusal(Reason.PLUGIN, `worker ${worker.name}: open is not a call`);
            }

            const [problem] = await tryit(async () => {
                await worker.open!();
            })();

            if (problem) {
                throw new Refusal(Reason.PLUGIN, `worker ${worker.name}: open failed: ${problem.message}`);
            }
        }
    }
}

/** §22.2: a kind's worker: the one its `worker.name` names, or the config's only one. */
export function workerOf(config: RigConfig, worker: KindWorker): Worker | undefined {
    const workers = workersOf(config);

    if (worker.name === undefined) {
        return workers.length === 1 ? workers[0] : undefined;
    }

    return workers.find((one) => {
        return one.name === worker.name;
    });
}

/** §22.1: every worker plugin: slot, name, every call; in the order of §8. */
export function checkWorkers(config: RigConfig): void {
    const names = new Set<string>();

    for (const worker of workersOf(config)) {
        if ((worker.slot as string) !== Slot.WORKER) {
            throw new Refusal(
                Reason.PLUGIN,
                `worker ${String(worker.name)}: slot is ${String(worker.slot)}, not worker`,
            );
        }

        if (!NAME.test(worker.name ?? "") || names.has(worker.name)) {
            throw new Refusal(Reason.PLUGIN, `worker ${String(worker.name)}: name is not a name, or taken`);
        }

        names.add(worker.name);

        for (const call of CALLS) {
            if (!isFunction(worker[call])) {
                throw new Refusal(Reason.PLUGIN, `worker ${worker.name}: missing call ${call}`);
            }
        }
    }
}

function fail(path: string, message: string): never {
    throw new Refusal(Reason.CONFIG, `${path}: ${message}`);
}

/** §22.2: a kind's `worker`: its worker, its tags, and the worker's own keys, by the worker's `check`; a trial `setup`, for the first-boot script's size and the ports it needs. */
export function checkKindWorker(path: string, kind: Kind, config: RigConfig): ReturnType<Worker["setup"]> {
    const at = `${path}worker`;
    const { worker } = kind;

    if (!isObject(worker)) {
        fail(at, "not an object");
    }

    if (worker.name !== undefined && (!isString(worker.name) || !NAME.test(worker.name))) {
        fail(`${at}.name`, "not a name");
    }

    const plugin = workerOf(config, worker);

    if (!plugin) {
        fail(
            `${at}.name`,
            worker.name === undefined ? "the config has not one worker: name it" : `${worker.name} is not in workers`,
        );
    }

    if (
        !isArray(worker.tags) ||
        worker.tags.length === 0 ||
        !worker.tags.every((tag) => {
            return isString(tag) && NAME.test(tag);
        })
    ) {
        fail(`${at}.tags`, "at least one name");
    }

    const [problem] = tryit(() => {
        plugin.check(worker);
    })();

    if (problem) {
        fail(at, problem.message);
    }

    const setup = plugin.setup({ name: `${config.app}-${kind.name}-00000000`, tags: worker.tags, worker });

    /* The ports it needs are rules too (§20). */
    setup.ports.forEach((rule, index) => {
        const [bad] = tryit(() => {
            return expandRule(rule);
        })();

        if (bad) {
            fail(`${at}: its port ${index}`, bad.message);
        }
    });

    return setup;
}

/** §22.2: the worker takes a machine once it has an IP, and again when its IPs change. */
export async function addWorker(context: Context, known: Known): Promise<void> {
    const plugin = known.worker && workerOf(context.config, { name: known.worker.name, tags: [] });
    const ip = known.ip;

    if (
        !plugin ||
        !known.worker ||
        !ip ||
        (!ip.public && !ip.private) ||
        JSON.stringify(known.worker.ip) === JSON.stringify(ip)
    ) {
        return;
    }

    const { key, tags } = known.worker;
    const [error] = await tryit(plugin.add)({ name: known.name, ip, key, tags });

    /* A worker that fails is asked again next round; the round goes on. */
    if (!error) {
        known.worker = { ...known.worker, ip: { ...ip } };
        context.store.save();
    }
}

/** §22.2: the worker forgets a machine that is gone; one that fails does not keep it in the store. */
export async function dropWorker(context: Context, known: Known): Promise<void> {
    const plugin = known.worker && workerOf(context.config, { name: known.worker.name, tags: [] });

    if (plugin && known.worker?.ip) {
        await tryit(plugin.drop)(known.name);
    }
}

/** §22.2: no more machines come for a lost machine's tags, once the core stops recovering it. */
export async function spentWorker(context: Context, lost: Machine): Promise<void> {
    const plugin = lost.worker && workerOf(context.config, { name: lost.worker.name, tags: [] });

    if (plugin && lost.worker) {
        await tryit(plugin.spent)(lost.worker.tags);
    }
}
