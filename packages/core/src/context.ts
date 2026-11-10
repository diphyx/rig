import { Reason, State } from "./enums.js";
import { Refusal } from "./refusal.js";
import type { Known, Store } from "./store.js";
import type { Events, Kind, Machine, Provider, RigConfig, Shape } from "./types.js";

export type Handler<E extends keyof Events> = (data: Events[E]) => void;

/** What every part of one core shares. */
export type Context = {
    config: RigConfig;
    clock: () => number;
    sleep: (ms: number) => Promise<void>;
    store: Store;
    providers: Map<string, Provider>;
    kinds: Map<string, Kind>;
    state: State;
    /** Orphans already reported, so each is reported once. */
    orphans: Set<string>;
    /** Shapes asked of providers, by `<provider>/<type>`. */
    shapes: Map<string, Shape | null>;
    emit<E extends keyof Events>(event: E, data: Events[E]): void;
};

export function createEmitter() {
    const handlers = new Map<keyof Events, Set<Handler<keyof Events>>>();

    return {
        on<E extends keyof Events>(event: E, handler: Handler<E>): void {
            const set = handlers.get(event) ?? new Set();

            set.add(handler as Handler<keyof Events>);
            handlers.set(event, set);
        },

        emit<E extends keyof Events>(event: E, data: Events[E]): void {
            for (const handler of handlers.get(event) ?? []) {
                (handler as Handler<E>)(data);
            }
        },
    };
}

/** §20: every call but `open` and `on` needs an open core. */
export function live(context: Context): void {
    if (context.state !== State.OPEN) {
        throw new Refusal(Reason.CLOSED, context.state === State.NEW ? "the core is not open" : "the core is closed");
    }
}

/** An open core's known machine, or `unknown`. */
export function knownOf(context: Context, id: string): Known {
    live(context);

    return context.store.known(id);
}

/** A kind in the config, or `config`. */
export function kindOf(context: Context, name: string): Kind {
    const kind = context.kinds.get(name);

    if (!kind) {
        throw new Refusal(Reason.CONFIG, `no kind ${name}`);
    }

    return kind;
}

export function providerOf(context: Context, machine: Machine): Provider {
    return context.providers.get(machine.provider)!;
}

/** A provider able to do `call` for this machine, or `unsupported`. */
export function capable(context: Context, machine: Machine, call: "stop" | "disk" | "port"): Provider {
    const provider = providerOf(context, machine);

    if (!provider.can?.[call]) {
        throw new Refusal(Reason.UNSUPPORTED, `${provider.name} cannot ${call}`);
    }

    return provider;
}

/** A known machine as the app sees it: a copy, without the core's own keys. */
export function toMachine(known: Known): Machine {
    const { chain: _, ...machine } = known;

    return structuredClone(machine);
}
