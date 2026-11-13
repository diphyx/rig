import { tryit } from "radash";

import { userOf } from "./boot.js";
import { addWorker, dropWorker, kindWith, spentWorker } from "./workers.js";
import { Event, Status, Why } from "./enums.js";
import { type Context, providerOf, toMachine } from "./context.js";
import { failover } from "./failover.js";
import { dur } from "./parse.js";
import { countLeft } from "./risk.js";
import type { Known, Pending } from "./store.js";
import type { ProviderMachine } from "./types.js";

/* One end per machine at a time: an end asked while one runs waits for that one, and marks it `asked`. */
function once(context: Context, known: Known, work: () => Promise<void>): Promise<void> {
    const running = context.ending.get(known);

    if (running) {
        running.asked = true;

        return running.done;
    }

    const done = work().finally(() => {
        context.ending.delete(known);
    });

    context.ending.set(known, { done, asked: false });

    return done;
}

/* The provider's `end`, then out of the store; `lost` counts it as a loss (§15.1). */
async function forgo(context: Context, known: Known, lost: boolean): Promise<void> {
    /* Counted once its provider has ended it: an `end` that throws leaves it for the next round, not counted twice. */
    await providerOf(context, known).end(known.id);
    context.gone.add(`${known.provider}/${known.id}`);
    countLeft(context, known, lost);

    context.store.forget(known);
    context.store.save();
    await dropWorker(context, known);
}

/** The provider's `end`, then out of the store. */
export function end(context: Context, known: Known): Promise<void> {
    return once(context, known, async () => {
        await forgo(context, known, false);
        context.emit(Event.MACHINE_ENDED, { machine: toMachine({ ...known, status: Status.ENDED }) });
    });
}

/* §16: replace a lost machine, up to its kind's `recovers`; no room waits for the next round. */
async function recover(context: Context, pending: Pending): Promise<void> {
    const { store, emit } = context;
    const kind = context.kinds.get(pending.lost.kind);
    const recovers = kind?.recovers ?? 3;

    const drop = (): void => {
        store.pending = store.pending.filter((one) => {
            return one !== pending;
        });
    };

    if (!kind || pending.chain >= recovers) {
        drop();
        store.save();
        emit(Event.MACHINE_FAILED, { machine: pending.lost, recovers });
        await spentWorker(context, pending.lost);

        return;
    }

    /* §20: the replacement gets the lost machine's create options too. */
    const known = await failover(context, kindWith(kind, pending.options), pending.chain + 1, pending.options);

    if (!known) {
        if (!store.pending.includes(pending)) {
            store.pending.push(pending);
            store.save();
        }

        return;
    }

    drop();
    store.save();
    emit(Event.MACHINE_RECOVERED, { lost: pending.lost, machine: toMachine(known) });
}

/* §15.1, §16: count the loss and the hours it ran, `end` it so the provider removes what it left, then recover. */
function lose(context: Context, known: Known): Promise<void> {
    return once(context, known, async () => {
        await forgo(context, known, true);

        const lost = toMachine({ ...known, status: Status.ENDED });

        context.emit(Event.MACHINE_LOST, { machine: lost });

        /* The app ended it meanwhile: it wants no replacement. */
        if (context.ending.get(known)?.asked) {
            return;
        }

        await recover(context, { lost, chain: known.chain, ...(known.options && { options: known.options }) });
    });
}

/* A machine on the provider, by `<provider>/<id>`. */
type Listed = Map<string, { provider: string; machine: ProviderMachine }>;

/* §13: this app's machines on every provider; any without both tags is dropped, whatever `list` gives. */
async function listAll(context: Context): Promise<Listed> {
    const tags = { rig: "1", "rig-app": context.config.app };
    const listed: Listed = new Map();

    for (const [name, provider] of context.providers) {
        for (const machine of await provider.list(tags)) {
            if (machine.tags.rig === tags.rig && machine.tags["rig-app"] === tags["rig-app"]) {
                listed.set(`${name}/${machine.id}`, { provider: name, machine });
            }
        }
    }

    return listed;
}

/** §16: list every provider, compare with the store, act; one round at a time. */
export function round(context: Context): Promise<void> {
    /* One round at a time: a round asked for while one runs is that round. */
    context.running ??= pass(context).finally(() => {
        context.running = null;
    });

    return context.running;
}

async function pass(context: Context): Promise<void> {
    const { store, kinds, emit } = context;

    context.gone = new Set();

    /* Only what the store held before the list was taken: a machine made meanwhile, by a create or a recover, is not judged. */
    const before = [...store.machines];
    const listed = await listAll(context);

    const held = new Set(
        before.map((known) => {
            return `${known.provider}/${known.id}`;
        }),
    );

    /* The app may end a machine while the round awaits: one ended, or being ended, is not judged, nor ended twice. */
    const kept = (known: Known): boolean => {
        return store.machines.includes(known) && !context.ending.has(known);
    };

    for (const pending of [...store.pending]) {
        await recover(context, pending);
    }

    for (const known of before) {
        if (!kept(known)) {
            continue;
        }

        const now = listed.get(`${known.provider}/${known.id}`);

        if (!now || now.machine.status === Status.ENDED) {
            await lose(context, known);

            continue;
        }

        known.status = now.machine.status;

        if (now.machine.ip) {
            known.ip = now.machine.ip;
        }

        if (now.machine.image) {
            known.image = now.machine.image;
        }

        await addWorker(context, known);

        const life = kinds.get(known.kind)?.life;

        if (life && context.clock() - known.created > dur(life) && kept(known)) {
            await end(context, known);
        }
    }

    for (const [at, { provider, machine }] of listed) {
        /* Held when the round began, ended since (the list is older), or made since: not found. */
        const known =
            held.has(at) ||
            context.gone.has(at) ||
            store.machines.some((one) => {
                return `${one.provider}/${one.id}` === at;
            });

        if (known || machine.status === Status.ENDED) {
            continue;
        }

        const kind = machine.tags["rig-kind"] ?? "";
        const user = kinds.has(kind) ? userOf(kinds.get(kind)!) : undefined;
        const found: Known = {
            ...machine,
            provider,
            kind,
            name: machine.tags["rig-name"] ?? "",
            ...(user && { user }),
            chain: 0,
        };

        /* §22.2: a found job machine has no key in the store, so its worker cannot take it: it is ended, and said why. */
        if (kinds.get(kind)?.worker) {
            const [problem] = await tryit(async () => {
                await providerOf(context, found).end(found.id);
            })();

            if (!problem) {
                emit(Event.MACHINE_ENDED, {
                    machine: toMachine({ ...found, status: Status.ENDED }),
                    reason: Why.FOUND,
                });
            }
        } else if (kinds.has(kind)) {
            store.machines.push(found);
        } else if (!context.orphans.has(at)) {
            context.orphans.add(at);
            emit(Event.MACHINE_ORPHAN, { machine: toMachine(found) });
        }
    }

    store.save();
}
