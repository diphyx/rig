import { isString, tryit } from "radash";

import { Event, Market, Reason, Status } from "./enums.js";
import { capable, type Context, kindOf, knownOf, live, providerOf, toMachine } from "./context.js";
import { entrySteps, failover } from "./failover.js";
import { dur, isDur, isUint } from "./parse.js";
import { Refusal } from "./refusal.js";
import { addWorker } from "./workers.js";
import { end } from "./rounds.js";
import { riskOf } from "./risk.js";
import { checkMatch, expandRule, matchesRule, sameRule } from "./rules.js";
import type { Listed, Machine, Match, Rule } from "./types.js";

type Disk = { gb: number; ready: boolean };

const TIMEOUT = "10m";

/* §20: read until done, once before the first poll; past `timeout`, a refusal. */
async function wait<T>(
    context: Context,
    timeout: string | undefined,
    read: () => Promise<T>,
    done: (value: T) => boolean,
): Promise<T> {
    const limit = dur(timeout ?? TIMEOUT);
    const start = context.clock();

    for (;;) {
        const value = await read();

        if (done(value)) {
            return value;
        }

        if (context.clock() - start >= limit) {
            throw new Refusal(Reason.TIMEOUT, `still waiting after ${timeout ?? TIMEOUT}`);
        }

        await context.sleep(dur(context.config.poll ?? "5s"));
    }
}

function timeoutOf(timeout: string | undefined): string | undefined {
    if (timeout !== undefined && !isDur(timeout)) {
        throw new Refusal(Reason.CONFIG, "timeout: not a dur");
    }

    return timeout;
}

/* §20: the provider's view, copied into the store; gone from the provider, or from the store, is `ended`. */
async function fresh(context: Context, last: Machine): Promise<Machine> {
    const known = context.store.machines.find((machine) => {
        return machine.id === last.id;
    });

    if (!known) {
        return { ...last, status: Status.ENDED };
    }

    const now = await providerOf(context, known).get(known.id);

    if (!now) {
        return toMachine({ ...known, status: Status.ENDED });
    }

    known.status = now.status;

    if (now.ip) {
        known.ip = now.ip;
    }

    if (now.image) {
        known.image = now.image;
    }

    await addWorker(context, known);

    context.store.save();

    return toMachine(known);
}

/** §20: what the app calls on an open core. */
export function calls(context: Context) {
    return {
        place: {
            /** The places a failover would try, in its order, each with its risk. */
            async list(kind: string): Promise<Listed[]> {
                live(context);

                const one = kindOf(context, kind);
                const all = [];

                for (const entry of one.try) {
                    all.push(...(await entrySteps(context, one, entry)));
                }

                const listed: Listed[] = [];

                for (const { provider, ...place } of all) {
                    listed.push({ ...place, provider, risk: await riskOf(context, provider, place) });
                }

                return listed;
            },
        },

        machine: {
            /** §14: a failover; `null` when there is no room. */
            async create(kind: string): Promise<Machine | null> {
                live(context);

                const created = await failover(context, kindOf(context, kind), 0);

                if (!created) {
                    return null;
                }

                const machine = toMachine(created);

                context.emit(Event.MACHINE_CREATED, { machine });

                return machine;
            },

            /** The provider's view, copied into the store; `null` for an id the store does not hold. */
            async get(id: string): Promise<Machine | null> {
                live(context);

                const known = context.store.machines.find((machine) => {
                    return machine.id === id;
                });

                return known ? fresh(context, toMachine(known)) : null;
            },

            /** Until the machine has `status`, or is `ended`. */
            async wait(id: string, status: Status, timeout?: string): Promise<Machine> {
                let last = toMachine(knownOf(context, id));

                if (!Object.values(Status).includes(status)) {
                    throw new Refusal(Reason.CONFIG, `status: ${String(status)} is not a status`);
                }

                return wait(
                    context,
                    timeoutOf(timeout),
                    async () => {
                        last = await fresh(context, last);

                        return last;
                    },
                    (machine) => {
                        return machine.status === status || machine.status === Status.ENDED;
                    },
                );
            },

            async list(filter: { kind?: string } = {}): Promise<Machine[]> {
                live(context);

                if (filter.kind !== undefined) {
                    kindOf(context, filter.kind);
                }

                return context.store.machines
                    .filter((machine) => {
                        return filter.kind === undefined || machine.kind === filter.kind;
                    })
                    .map(toMachine);
            },

            async end(id: string): Promise<void> {
                await end(context, knownOf(context, id));
            },

            async start(id: string): Promise<void> {
                const known = knownOf(context, id);

                await capable(context, known, "stop").start!(known.id);
            },

            async stop(id: string): Promise<void> {
                const known = knownOf(context, id);
                const provider = capable(context, known, "stop");

                if (known.market === Market.SPOT) {
                    throw new Refusal(Reason.UNSUPPORTED, "a spot machine cannot stop");
                }

                await provider.stop!(known.id);
            },

            async reboot(id: string): Promise<void> {
                const known = knownOf(context, id);

                await providerOf(context, known).reboot(known.id);
            },
        },

        disk: {
            /** §20: a disk only grows: a size not above it now is a refusal. */
            async grow(id: string, gb: number): Promise<void> {
                const known = knownOf(context, id);
                const disk = capable(context, known, "disk").disk!;
                const now = await disk.get(known.id);

                if (!isUint(gb) || gb <= now.gb) {
                    throw new Refusal(Reason.CONFIG, `disk: ${String(gb)} GB is not above its ${now.gb} GB`);
                }

                await disk.grow(known.id, gb);
            },

            async get(id: string): Promise<Disk> {
                const known = knownOf(context, id);

                return capable(context, known, "disk").disk!.get(known.id);
            },

            /** Until the disk is ready. */
            async wait(id: string, timeout?: string): Promise<Disk> {
                const known = knownOf(context, id);
                const disk = capable(context, known, "disk").disk!;

                return wait(
                    context,
                    timeoutOf(timeout),
                    () => {
                        return disk.get(known.id);
                    },
                    (one) => {
                        return one.ready;
                    },
                );
            },
        },

        port: {
            /** §20: a rule that is one, `from: any` as two; an equal rule the machine has is given back as it is. */
            async open(id: string, rule: Rule): Promise<Rule[]> {
                const known = knownOf(context, id);
                const port = capable(context, known, "port").port!;
                const rules = expandRule(rule);
                const held = await port.list(known.id);
                const opened: Rule[] = [];
                const made: Rule[] = [];

                try {
                    for (const one of rules) {
                        const equal = held.find((other) => {
                            return sameRule(other, one);
                        });

                        const rule = equal ?? (await port.open(known.id, one));

                        if (!equal) {
                            made.push(rule);
                        }

                        opened.push(rule);
                    }
                } catch (error) {
                    /* §20: all or none: what this call opened is closed again. */
                    for (const one of made) {
                        await tryit(port.close)(known.id, one.id!);
                    }

                    throw error;
                }

                return opened;
            },

            /** §20: the rule with that id, or every rule the match matches; the rules closed, none is `[]`. */
            async close(id: string, rule: string | Match): Promise<Rule[]> {
                const known = knownOf(context, id);
                const port = capable(context, known, "port").port!;

                if (!isString(rule)) {
                    checkMatch(rule);
                }

                const closing = (await port.list(known.id)).filter((one) => {
                    return isString(rule) ? one.id === rule : matchesRule(one, rule);
                });

                for (const one of closing) {
                    await port.close(known.id, one.id!);
                }

                return closing;
            },

            async list(id: string): Promise<Rule[]> {
                const known = knownOf(context, id);

                return capable(context, known, "port").port!.list(known.id);
            },
        },
    };
}
