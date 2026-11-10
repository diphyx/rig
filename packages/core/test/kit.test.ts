import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isArray } from "radash";
import { describe, expect, it } from "vitest";

import { Busy, createRig, Event, Refusal, Slot, Status } from "../src/index.js";
import { dur } from "../src/parse.js";
import type { Answer, Place, Provider, ProviderMachine, Rig, RigConfig, Shape, Spec, Tags } from "../src/index.js";

/* The kit's own format: spec/kit/README.md. */
type Fake = {
    places: Place[];
    answers: Record<string, string | string[]>;
    machines?: ProviderMachine[];
    boot?: number;
    throws?: string[];
    filter?: boolean;
    shapes?: Record<string, Shape>;
};

type Step = { do: string; call?: string; args?: unknown[]; id?: string; by?: string; expect?: Expect };

type Expect = {
    result?: unknown;
    refusal?: string;
    throws?: true;
    events?: Record<string, unknown>[];
    store?: { risk?: unknown };
    fake?: Record<string, { machines?: unknown[] }>;
};

type Case = {
    id: string;
    description: string;
    given: { config: RigConfig; fake: Record<string, Fake>; store?: { risk?: unknown } };
    steps: Step[];
};

type Kit = { rig: number; area: string; cases: Case[] };

const KIT = join(import.meta.dirname, "../../../spec/kit");

const kits = readdirSync(KIT)
    .filter((file) => {
        return file.endsWith(".json") && file !== "schema.json";
    })
    .map((file) => {
        return JSON.parse(readFileSync(join(KIT, file), "utf8")) as Kit;
    });

/* README §6: an expected object matches on its own keys; a list on its length and items, in order. */
function match(actual: unknown, expected: unknown, path = "$"): void {
    if (isArray(expected)) {
        expect(isArray(actual), `${path} is a list`).toBe(true);
        expect((actual as unknown[]).length, `${path} length`).toBe(expected.length);

        expected.forEach((item, index) => {
            match((actual as unknown[])[index], item, `${path}[${index}]`);
        });

        return;
    }

    if (typeof expected === "object" && expected !== null) {
        expect(typeof actual === "object" && actual !== null, `${path} is an object`).toBe(true);

        for (const [key, value] of Object.entries(expected)) {
            match((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
        }

        return;
    }

    expect(actual, path).toEqual(expected);
}

/* README §3: a fake provider from data, playing its answers in turn. */
function fakes(
    config: RigConfig,
    data: Record<string, Fake>,
    clock: () => number,
    stray: string[],
): { providers: Provider[]; machines: Map<string, ProviderMachine[]> } {
    const machines = new Map<string, ProviderMachine[]>();
    let next = 0;

    const providers = (
        config.providers as unknown as { name: string; can?: Provider["can"]; rig?: number; check?: string }[]
    ).map((written) => {
        const fake = data[written.name] ?? { places: [], answers: {} };
        const own: ProviderMachine[] = structuredClone(fake.machines ?? []);
        const booting = new Map<string, number>();
        const disks = new Map<string, number>();

        const answers = new Map(
            Object.entries(fake.answers).map(([at, answer]) => {
                return [at, [answer].flat()];
            }),
        );

        const find = (id: string): ProviderMachine | null => {
            return (
                own.find((machine) => {
                    return machine.id === id;
                }) ?? null
            );
        };

        machines.set(written.name, own);

        const provider: Provider = {
            slot: Slot.PROVIDER,
            name: written.name,
            rig: written.rig ?? 1,
            ...(written.can && { can: written.can }),
            ...(fake.shapes && {
                async shape(type: string) {
                    return fake.shapes![type] ?? null;
                },
            }),
            ...(written.check && {
                async check() {
                    if (written.check === "fail") {
                        throw new Error("fake check failed");
                    }
                },
            }),
            async places(entry) {
                return fake.places.filter((place) => {
                    return entry.market.includes(place.market) && entry.types.includes(place.type);
                });
            },
            async create(place: Place, spec: Spec): Promise<Answer> {
                const at = `${place.market}/${place.type}/${place.zone}`;
                const answer = answers.get(at)?.shift();

                if (answer === undefined) {
                    stray.push(`${written.name}/${at}`);

                    throw new Error(`stray try at ${written.name}/${at}`);
                }

                if (answer === "throw") {
                    throw new Error("fake throw");
                }

                if (answer.startsWith("busy ")) {
                    return { busy: answer.slice(5) as Busy };
                }

                next += 1;
                booting.set(`m${next}`, fake.boot ?? 0);

                own.push({
                    id: `m${next}`,
                    status: (fake.boot ?? 0) > 0 ? Status.PENDING : Status.RUNNING,
                    ip: { private: `10.0.0.${next}` },
                    market: place.market,
                    type: place.type,
                    zone: place.zone,
                    tags: spec.tags,
                    created: clock(),
                });

                return { ok: { id: `m${next}` } };
            },
            /* Copies, as a real provider gives: the core must not see the fake change under it. */
            async get(id) {
                const machine = find(id);
                const left = booting.get(id) ?? 0;

                if (machine?.status === Status.PENDING) {
                    if (left > 0) {
                        booting.set(id, left - 1);
                    } else {
                        machine.status = Status.RUNNING;
                    }
                }

                return structuredClone(machine);
            },
            async list(tags: Tags) {
                return structuredClone(
                    own.filter((machine) => {
                        return (
                            machine.status !== Status.ENDED &&
                            (fake.filter === false ||
                                Object.entries(tags).every(([name, value]) => {
                                    return machine.tags[name] === value;
                                }))
                        );
                    }),
                );
            },
            async end(id) {
                const machine = find(id);

                if (machine) {
                    machine.status = Status.ENDED;
                }
            },
            async reboot() {},
            ...(written.can?.disk && {
                disk: {
                    async grow(id: string, gb: number) {
                        disks.set(id, gb);
                    },
                    async get(id: string) {
                        return { gb: disks.get(id) ?? 30, ready: true };
                    },
                },
            }),
            ...(written.can?.stop && {
                async start(id: string) {
                    find(id)!.status = Status.RUNNING;
                },
                async stop(id: string) {
                    find(id)!.status = Status.STOPPED;
                },
            }),
        };

        for (const call of fake.throws ?? []) {
            (provider as unknown as Record<string, unknown>)[call] = async () => {
                throw new Error(`fake ${call} throws`);
            };
        }

        return provider;
    });

    return { providers, machines };
}

/* README §5's `try` short form. */
function short(event: Event, data: Record<string, unknown>): Record<string, unknown> {
    if (event !== Event.TRY) {
        return { event, ...data };
    }

    const place = data.place as Place & { provider: string };
    const answer = data.answer as Record<string, unknown>;

    return {
        event,
        kind: data.kind,
        place: `${place.provider}/${place.market}/${place.type}/${place.zone}`,
        answer: "ok" in answer ? "ok" : "busy" in answer ? `busy ${String(answer.busy)}` : "throw",
    };
}

async function act(rig: Rig, step: Step, time: { now: number }, machines: Map<string, ProviderMachine[]>) {
    switch (step.do) {
        case "open":
            return rig.open();
        case "close":
            return rig.close();
        case "round":
            return rig.round();
        case "take-back":
            for (const own of machines.values()) {
                for (const machine of own) {
                    if (machine.id === step.id) {
                        machine.status = Status.ENDED;
                    }
                }
            }

            return;
        case "clock":
            time.now += dur(step.by!);

            return;
        default: {
            const [group, name] = step.call!.split(".") as [string, string];
            const target = (rig as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[group]!;

            return target[name]!(...step.args!);
        }
    }
}

async function play(one: Case): Promise<void> {
    const time = { now: 0 };
    const clock = (): number => {
        return time.now;
    };

    const folder = mkdtempSync(join(tmpdir(), "rig-kit-"));
    const stray: string[] = [];
    const { providers, machines } = fakes(one.given.config, one.given.fake, clock, stray);

    if (one.given.store?.risk) {
        mkdirSync(join(folder, "rig", "1"), { recursive: true });
        writeFileSync(join(folder, "rig", "1", "risk.json"), JSON.stringify(one.given.store.risk));
    }

    const sleep = async (ms: number): Promise<void> => {
        time.now += ms;
    };

    const rig = createRig({ ...one.given.config, providers, store: folder, extra: { clock, sleep, rounds: false } });
    const events: Record<string, unknown>[] = [];

    for (const event of Object.values(Event)) {
        rig.on(event, (data) => {
            events.push(short(event, data as Record<string, unknown>));
        });
    }

    for (const [index, step] of one.steps.entries()) {
        const at = `${one.id} step ${index} (${step.do}${step.call ? ` ${step.call}` : ""})`;
        const want = step.expect ?? {};

        events.length = 0;

        let result: unknown;
        let failure: unknown;

        try {
            result = await act(rig, step, time, machines);
        } catch (error) {
            failure = error;
        }

        expect(stray, `${at}: tried a place with no answer left`).toEqual([]);

        if (want.refusal) {
            expect(failure, `${at}: a refusal`).toBeInstanceOf(Refusal);
            expect((failure as Refusal).reason, `${at}: refusal reason`).toBe(want.refusal);
        } else if (want.throws) {
            expect(failure, `${at}: a throw`).toBeDefined();
            expect(failure, `${at}: a throw, not a refusal`).not.toBeInstanceOf(Refusal);
        } else if (failure !== undefined) {
            throw failure;
        }

        if ("result" in want) {
            match(result, want.result, `${at}: result`);
        }

        if (want.events) {
            match(events, want.events, `${at}: events`);
        }

        if (want.store?.risk) {
            match(
                JSON.parse(readFileSync(join(folder, "rig", "1", "risk.json"), "utf8")),
                want.store.risk,
                `${at}: store`,
            );
        }

        for (const [name, fake] of Object.entries(want.fake ?? {})) {
            match(machines.get(name), fake.machines, `${at}: fake ${name}`);
        }
    }
}

for (const kit of kits) {
    describe(`kit: ${kit.area}`, () => {
        for (const one of kit.cases) {
            it(`${one.id}: ${one.description}`, async () => {
                await play(one);
            });
        }
    });
}
