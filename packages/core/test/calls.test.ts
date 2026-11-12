import { afterEach, describe, expect, it, vi } from "vitest";

import {
    Arch,
    createRig,
    Event,
    Market,
    type Provider,
    Reason,
    Refusal,
    type RigConfig,
    type Spec,
    Status,
    type Worker,
} from "../src/index.js";

import { fakeProvider, fakeWorker, storeOf } from "./fake.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me@host";
const ENTRY = { provider: "a", market: [Market.DEMAND], types: ["t"] };

/* A core of one provider and one kind, its clock moved by its own sleep; `own` over the config's keys. */
async function opened(provider: Provider, kind: Record<string, unknown> = {}, own: Partial<RigConfig> = {}) {
    const time = { now: 0 };
    const rig = createRig({
        rig: 1,
        app: "app",
        providers: [provider],
        kinds: [{ name: "d", try: [ENTRY], ...kind }],
        store: storeOf(),
        extra: {
            clock: () => {
                return time.now;
            },
            sleep: async (ms: number) => {
                time.now += ms;
            },
            rounds: false,
        },
        ...own,
    });

    await rig.open();

    return rig;
}

/* The refusal a call gives. */
async function refusalOf(call: Promise<unknown>): Promise<Refusal> {
    const failure = await call.then(
        () => {
            return undefined;
        },
        (error: unknown) => {
            return error;
        },
    );

    expect(failure).toBeInstanceOf(Refusal);

    return failure as Refusal;
}

describe("machine calls", () => {
    it("starts, stops and reboots a machine through its provider", async () => {
        const { provider, machines, calls } = fakeProvider({ can: { stop: true } });
        const rig = await opened(provider);
        const machine = await rig.machine.create("d");

        await rig.machine.stop(machine!.id);
        expect(machines[0]!.status).toBe(Status.STOPPED);

        await rig.machine.start(machine!.id);
        await rig.machine.reboot(machine!.id);

        expect(calls).toEqual(["stop m1", "start m1", "reboot m1"]);
    });

    it("refuses a list filter that is not an object", async () => {
        const rig = await opened(fakeProvider().provider);

        expect((await refusalOf(rig.machine.list("d" as never))).message).toBe("filter: not an object");
    });

    it("waits up to 10m by default, then refuses", async () => {
        const { provider } = fakeProvider({
            async get(id) {
                return {
                    id,
                    status: Status.PENDING,
                    market: Market.DEMAND,
                    type: "t",
                    zone: "z",
                    tags: {},
                    created: 0,
                };
            },
        });

        const rig = await opened(provider);
        const machine = await rig.machine.create("d");

        expect(await refusalOf(rig.machine.wait(machine!.id, Status.RUNNING))).toMatchObject({
            reason: Reason.TIMEOUT,
            message: "still waiting after 10m",
        });
    });

    it("sees a machine its provider no longer has as ended", async () => {
        const { provider, machines } = fakeProvider();
        const rig = await opened(provider);
        const machine = await rig.machine.create("d");

        machines.length = 0;

        expect(await rig.machine.get(machine!.id)).toMatchObject({ id: machine!.id, status: Status.ENDED });
    });

    it("ends a wait when the machine leaves the store while it waits", async () => {
        const { provider, machines } = fakeProvider();
        const ends: string[] = [];
        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [{ name: "d", try: [ENTRY] }],
            store: storeOf(),
            extra: {
                /* Between two reads, the app ends the machine. */
                sleep: async () => {
                    for (const id of ends.splice(0)) {
                        await rig.machine.end(id);
                    }
                },
                rounds: false,
            },
        });

        await rig.open();

        const machine = await rig.machine.create("d");

        machines[0]!.status = Status.PENDING;
        ends.push(machine!.id);

        expect(await rig.machine.wait(machine!.id, Status.RUNNING)).toMatchObject({
            id: machine!.id,
            status: Status.ENDED,
        });
    });

    it("gives the provider the kind's disk and the entry's extra", async () => {
        const specs: Spec[] = [];
        const fake = fakeProvider();
        const { provider } = fakeProvider({
            async create(place, spec) {
                specs.push(spec);

                return fake.provider.create(place, spec);
            },
        });

        const rig = await opened(provider, { disk: 40, try: [{ ...ENTRY, extra: { zone: "z" } }] });

        await rig.machine.create("d");

        expect(specs).toMatchObject([{ disk: 40, extra: { zone: "z" } }]);
    });
});

describe("create options", () => {
    /* A worker that needs a port when its kind's worker asks for one. */
    const porter: Worker = fakeWorker({
        setup(machine) {
            return {
                script: [],
                ports: machine.worker.port ? [{ port: 9420, from: "203.0.113.9/32" }] : [],
                key: "k",
            };
        },
    });

    it("refuses options that are not an object, or a worker that is not one", async () => {
        const rig = await opened(fakeProvider().provider, { worker: { tags: ["x"] } }, { workers: [porter] });

        expect((await refusalOf(rig.machine.create("d", "x" as never))).message).toBe("options: not an object");

        expect((await refusalOf(rig.machine.create("d", { worker: "x" as never }))).message).toBe(
            "options.worker: not an object",
        );
    });

    it("takes options without a worker as none", async () => {
        const rig = await opened(fakeProvider().provider, { worker: { tags: ["x"] } }, { workers: [porter] });

        expect(await rig.machine.create("d", {})).toMatchObject({ kind: "d", worker: { tags: ["x"] } });
    });

    it("refuses a worker whose options need ports a provider cannot open", async () => {
        const { provider } = fakeProvider({ can: undefined });
        const rig = await opened(provider, { worker: { tags: ["x"] } }, { workers: [porter] });

        expect((await refusalOf(rig.machine.create("d", { worker: { port: true } }))).message).toBe(
            "options.worker: a cannot open the ports its worker needs",
        );
    });
});

describe("port calls", () => {
    it("closes the rules a match of `to` alone matches", async () => {
        const rig = await opened(fakeProvider({ can: { port: true } }).provider);
        const machine = await rig.machine.create("d");

        await rig.port.open(machine!.id, { port: 8000, to: 8010, from: "203.0.113.9" });
        await rig.port.open(machine!.id, { port: 22, from: "203.0.113.9" });

        expect(await rig.port.close(machine!.id, { to: 8010 })).toMatchObject([{ port: 8000, to: 8010 }]);
        expect(await rig.port.list(machine!.id)).toMatchObject([{ port: 22 }]);
    });

    it("refuses a match that is not an object, and a rule whose from is not a str", async () => {
        const rig = await opened(fakeProvider({ can: { port: true } }).provider);
        const machine = await rig.machine.create("d");

        expect((await refusalOf(rig.port.close(machine!.id, 5 as never))).message).toBe(
            "rule: a match needs port, to, protocol or from",
        );

        expect((await refusalOf(rig.port.open(machine!.id, "22" as never))).message).toBe(
            "rule: a rule needs port and from",
        );
    });
});

describe("place risk", () => {
    it("rates a spot place's prior by its type's cpu and arch", async () => {
        const shapes = {
            t8: { cpu: 8, mem: 32, arch: Arch.X86 },
            t32: { cpu: 32, mem: 128, arch: Arch.X86 },
            t64: { cpu: 64, mem: 256, arch: Arch.ARM },
        };

        const { provider } = fakeProvider({
            can: { spot: true },
            async places() {
                return Object.keys(shapes).map((type) => {
                    return { market: Market.SPOT, type, zone: "z" };
                });
            },
            async shape(type) {
                return shapes[type as keyof typeof shapes];
            },
        });

        const rig = await opened(provider, {
            try: [{ provider: "a", market: [Market.SPOT], types: Object.keys(shapes) }],
        });

        expect(
            (await rig.place.list("d")).map((place) => {
                return place.risk.prior;
            }),
        ).toEqual([10, 12, 12.8]);
    });
});

describe("rounds", () => {
    it("takes a found machine of a kind with a login, and reports one without a kind as an orphan", async () => {
        const { provider, machines } = fakeProvider();
        const rig = await opened(provider, { login: { keys: [KEY] } });
        const orphans: string[] = [];

        rig.on(Event.MACHINE_ORPHAN, ({ machine }) => {
            orphans.push(machine.id);
        });

        await rig.machine.create("d");

        const base = { status: Status.RUNNING, market: Market.DEMAND, type: "t", zone: "z", created: 0 };

        machines.push(
            { ...base, id: "found", tags: { rig: "1", "rig-app": "app", "rig-kind": "d" } },
            { ...base, id: "orphan", tags: { rig: "1", "rig-app": "app" } },
        );

        await rig.round();

        expect(orphans).toEqual(["orphan"]);
        expect(await rig.machine.list()).toMatchObject([{ id: "m1" }, { id: "found", name: "", user: "ubuntu" }]);
    });
});

describe("core", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens once: a second open does nothing", async () => {
        const { provider } = fakeProvider();
        const rig = await opened(provider);

        await rig.open();
        expect(await rig.machine.list()).toEqual([]);
    });

    it("takes the store folder ./.rig when the config names none", () => {
        expect(() => {
            return createRig({ rig: 1, app: "app", providers: [], kinds: [] });
        }).not.toThrow();
    });

    it("runs a round every `every`, and sleeps and reads the time on its own without extra", async () => {
        vi.useFakeTimers();

        const { provider, machines } = fakeProvider();
        const lists = vi.fn(provider.list);
        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [{ ...provider, list: lists }],
            kinds: [{ name: "d", try: [ENTRY] }],
            store: storeOf(),
            every: "1m",
            poll: "1s",
        });

        await rig.open();
        expect(lists).toHaveBeenCalledTimes(1);

        const machine = await rig.machine.create("d");

        machines[0]!.status = Status.PENDING;

        const waiting = rig.machine.wait(machine!.id, Status.RUNNING);

        await vi.advanceTimersByTimeAsync(500);
        machines[0]!.status = Status.RUNNING;
        await vi.advanceTimersByTimeAsync(500);

        expect(await waiting).toMatchObject({ status: Status.RUNNING });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(lists).toHaveBeenCalledTimes(2);

        await rig.close();
    });
});
