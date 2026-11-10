import { type Context, providerOf, toMachine } from "./context.js";
import { failover } from "./failover.js";
import { dur } from "./parse.js";
import { type Known, type Pending, placeKey } from "./store.js";
import type { ProviderMachine } from "./types.js";

const HOUR = 3_600_000;

/** The provider's `end`, then out of the store. */
export async function end(context: Context, known: Known): Promise<void> {
    await providerOf(context, known).end(known.id);

    context.store.forget(known);
    context.store.save();
    context.emit("machine:ended", { machine: toMachine({ ...known, status: "ended" }) });
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
        emit("machine:failed", { machine: pending.lost, recovers });

        return;
    }

    const known = await failover(context, kind, pending.chain + 1);

    if (!known) {
        if (!store.pending.includes(pending)) {
            store.pending.push(pending);
            store.save();
        }

        return;
    }

    drop();
    store.save();
    emit("machine:recovered", { lost: pending.lost, machine: toMachine(known) });
}

/* §15, §16: count the loss and the hours it ran, then recover. */
async function lose(context: Context, known: Known): Promise<void> {
    const { store } = context;
    const seen = store.seen(placeKey(known.provider, known));
    const hours = (context.clock() - known.created) / HOUR;

    seen.hours = Math.round((seen.hours * seen.lost + hours) / (seen.lost + 1));
    seen.lost += 1;

    store.forget(known);
    store.save();

    const lost = toMachine({ ...known, status: "ended" });

    context.emit("machine:lost", { machine: lost });
    await recover(context, { lost, chain: known.chain });
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

/** §16: list every provider, compare with the store, act. */
export async function round(context: Context): Promise<void> {
    const { store, kinds, emit } = context;
    const listed = await listAll(context);

    /* Only what the store held when the list was taken: a machine a recover makes now is not in it. */
    const before = [...store.machines];
    const held = new Set(
        before.map((known) => {
            return `${known.provider}/${known.id}`;
        }),
    );

    for (const pending of [...store.pending]) {
        await recover(context, pending);
    }

    for (const known of before) {
        const now = listed.get(`${known.provider}/${known.id}`);

        if (!now || now.machine.status === "ended") {
            await lose(context, known);

            continue;
        }

        known.status = now.machine.status;

        if (now.machine.ip) {
            known.ip = now.machine.ip;
        }

        const life = kinds.get(known.kind)?.life;

        if (life && context.clock() - known.created > dur(life)) {
            await end(context, known);
        }
    }

    for (const [at, { provider, machine }] of listed) {
        if (held.has(at) || machine.status === "ended") {
            continue;
        }

        const kind = machine.tags["rig-kind"] ?? "";
        const found: Known = { ...machine, provider, kind, name: machine.tags["rig-name"] ?? "", chain: 0 };

        if (kinds.has(kind)) {
            store.machines.push(found);
        } else if (!context.orphans.has(at)) {
            context.orphans.add(at);
            emit("machine:orphan", { machine: toMachine(found) });
        }
    }

    store.save();
}
