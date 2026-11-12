/* A stage: a core on a store of its own, its events logged, and every machine it made ended after it. */
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { all, tryit } from "radash";

import { createRig, Event, type Kind, type Rig, type Worker } from "@diphyx/rig";

import { log, scoped } from "./log.ts";
import { APP, providersOf } from "./clouds.ts";

const STORES = join(dirname(fileURLToPath(import.meta.url)), "..", ".rig");

/* The machine events, each logged with its machine's id. */
const EVENTS = [
    Event.MACHINE_CREATED,
    Event.MACHINE_ENDED,
    Event.MACHINE_LOST,
    Event.MACHINE_RECOVERED,
    Event.MACHINE_FAILED,
    Event.MACHINE_ORPHAN,
];

/** Calls at once, each run to its end; the first error thrown as it is, so the stage names it. */
export async function together(...calls: Promise<unknown>[]): Promise<void> {
    try {
        await all(calls);
    } catch (error) {
        throw (error as AggregateError).errors?.[0] ?? error;
    }
}

/** `body` for each item at once; true when every one is. */
export async function everyOf<T>(items: T[], body: (item: T) => Promise<boolean>): Promise<boolean> {
    return (await all(items.map(body))).every(Boolean);
}

/** Every stage done, in the order each ended: its name, pass or fail, its time. */
export const DONE: { name: string; passed: boolean; seconds: number }[] = [];

/** What a stage's core runs: its kinds, and its workers, if any. */
export type Setup = { kinds: Kind[]; workers?: Worker[] };

/** A core on the stage's own store, emptied; rounds only by `rig.round()`, every event logged. */
export function coreOf(name: string, { kinds, workers = [] }: Setup): Rig {
    const store = join(STORES, name.replace(/[^a-z0-9]+/g, "-"));

    rmSync(store, { recursive: true, force: true });

    const rig = createRig({ rig: 1, app: APP, providers: providersOf(), workers, kinds, every: "0", store });

    rig.on(Event.TRY, ({ place, answer }) => {
        log("try", `${place.provider}/${place.market}/${place.type}/${place.zone}`, JSON.stringify(answer));
    });

    for (const event of EVENTS) {
        rig.on(event, (data) => {
            log("event", event, (data as { machine?: { id: string } }).machine?.id ?? "");
        });
    }

    rig.on(Event.GUARD, ({ kind, code }) => {
        log("guard", kind, code);
    });

    return rig;
}

/** A stage on a core of its own; after it, pass or fail, every machine its store holds is ended and the core closed. */
export function stage(name: string, setup: Setup, body: (rig: Rig) => Promise<void>): Promise<boolean> {
    return scoped(name, async () => {
        const rig = coreOf(name, setup);
        const started = Date.now();

        log("started");

        const [error] = await tryit(async () => {
            await rig.open();
            await body(rig);
        })();

        if (error) {
            log("!!", error.message);
        }

        /* A core that never opened holds no machine. */
        const [, held] = await tryit(rig.machine.list)();

        await all(
            (held ?? []).map(async (machine) => {
                log("cleanup: end", machine.id);

                const [failed] = await tryit(rig.machine.end)(machine.id);

                if (failed) {
                    log("cleanup failed", machine.id, failed.message, "→ run: pnpm test:e2e run sweep");
                }
            }),
        );

        await tryit(rig.close)();

        const seconds = Math.round((Date.now() - started) / 1000);

        DONE.push({ name, passed: !error, seconds });
        log(`${error ? "failed" : "passed"} in ${seconds}s`);

        return !error;
    });
}
