import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { all } from "radash";
import { describe, expect, it } from "vitest";

import {
    createRig,
    Event,
    Market,
    DISTROS,
    type Provider,
    type ProviderMachine,
    Slot,
    Status,
    type Worker,
} from "../src/index.js";

/* A provider and a worker whose calls can each be held until the test lets them go: `list` before it looks,
   `listed` once it has looked, `end <id>`, and `add`. */
function world() {
    const machines: ProviderMachine[] = [];
    const ends: string[] = [];
    const drops: string[] = [];
    const gates = new Map<string, { at: Promise<void>; open: () => void }>();
    let lists = 0;

    const wait = async (name: string): Promise<void> => {
        await gates.get(name)?.at;
    };

    const find = (id: string): ProviderMachine => {
        return machines.find((one) => {
            return one.id === id;
        })!;
    };

    const provider: Provider = {
        slot: Slot.PROVIDER,
        name: "a",
        rig: 1,
        can: { port: true },
        distros: Object.fromEntries(
            Object.entries(DISTROS).map(([distro, { versions }]) => {
                return [distro, versions];
            }),
        ),
        async places() {
            return [{ market: Market.DEMAND, type: "t", zone: "z" }];
        },
        async create(place, spec) {
            const id = `m${machines.length + 1}`;

            machines.push({
                id,
                status: Status.RUNNING,
                market: place.market,
                type: place.type,
                zone: place.zone,
                tags: spec.tags,
                ip: { private: "10.0.0.1" },
                created: 0,
            });

            return { ok: { id } };
        },
        async get(id) {
            return structuredClone(find(id) ?? null);
        },
        async list() {
            lists += 1;
            await wait("list");

            const now = structuredClone(
                machines.filter((one) => {
                    return one.status !== Status.ENDED;
                }),
            );

            await wait("listed");

            return now;
        },
        async end(id) {
            ends.push(id);
            find(id).status = Status.ENDED;
            await wait(`end ${id}`);
        },
        async reboot() {},
        port: {
            async open(_id, rule) {
                return rule;
            },
            async close() {},
            async list() {
                return [];
            },
        },
    };

    const worker: Worker = {
        slot: Slot.WORKER,
        name: "w",
        rig: 1,
        check() {},
        setup() {
            return { script: ["echo worker"], ports: [], key: "k" };
        },
        async add() {
            await wait("add");
        },
        async drop(name) {
            drops.push(name);
        },
        async spent() {},
    };

    return {
        provider,
        worker,
        machines,
        ends,
        drops,
        lists: () => {
            return lists;
        },
        hold: (name: string) => {
            let open: () => void = () => {};
            const at = new Promise<void>((resolve) => {
                open = resolve;
            });

            gates.set(name, { at, open });
        },
        go: (name: string) => {
            gates.get(name)!.open();
            gates.delete(name);
        },
        takeBack: (id: string) => {
            find(id).status = Status.ENDED;
        },
    };
}

/* Lets every running call go on until each waits on a held gate. */
function settle(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

/* An open core on that world: kind `d`, and job kind `j` past its `life`; `events` as `<event> <id>`. */
async function opened() {
    const fake = world();
    const rig = createRig({
        rig: 1,
        app: "app",
        providers: [fake.provider],
        workers: [fake.worker],
        kinds: [
            { name: "d", try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }] },
            {
                name: "j",
                try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }],
                worker: { tags: ["build"] },
                life: "1h",
            },
        ],
        store: mkdtempSync(join(tmpdir(), "rig-rounds-")),
        extra: {
            rounds: false,
            clock: () => {
                return 2 * 3_600_000;
            },
        },
    });

    const events: string[] = [];

    for (const event of [Event.MACHINE_CREATED, Event.MACHINE_ENDED, Event.MACHINE_LOST, Event.MACHINE_RECOVERED]) {
        rig.on(event, (data) => {
            events.push(`${event} ${(data as { machine: { id: string } }).machine.id}`);
        });
    }

    await rig.open();

    return { ...fake, rig, events };
}

describe("rounds", () => {
    it("never takes a machine made while a round lists for a lost one", async () => {
        const { rig, events, hold, go } = await opened();

        hold("listed");

        const round = rig.round();
        const machine = await rig.machine.create("d");

        go("listed");
        await round;

        expect(events).toEqual([`machine:created ${machine!.id}`]);
        expect(await rig.machine.list()).toMatchObject([{ id: machine!.id }]);
    });

    it("runs one round at a time: a round asked for while one runs is that round", async () => {
        const { rig, hold, go, lists } = await opened();
        const before = lists();

        hold("list");

        const first = rig.round();
        const second = rig.round();

        go("list");
        await all([first, second]);

        expect(lists() - before).toBe(1);
    });

    it("ends a machine once when the app ends it while a round lists: never lost, never recovered", async () => {
        const { rig, events, ends, machines, hold, go } = await opened();

        await rig.machine.create("d");
        events.length = 0;
        hold("list");

        const round = rig.round();

        await settle();
        await rig.machine.end("m1");
        go("list");
        await round;

        expect(events).toEqual(["machine:ended m1"]);
        expect(ends).toEqual(["m1"]);
        expect(machines).toHaveLength(1);
    });

    it("ends a machine once when a round runs while the app's end of it is still at the provider", async () => {
        const { rig, events, ends, machines, hold, go } = await opened();

        await rig.machine.create("d");
        events.length = 0;
        hold("end m1");

        const ended = rig.machine.end("m1");

        await settle();

        const round = rig.round();

        await settle();
        go("end m1");
        await all([ended, round]);

        expect(events).toEqual(["machine:ended m1"]);
        expect(ends).toEqual(["m1"]);
        expect(machines).toHaveLength(1);
    });

    it("does not recover a lost machine the app ends while the round ends it, nor end it twice", async () => {
        const { rig, events, ends, machines, hold, go, takeBack } = await opened();

        await rig.machine.create("d");
        events.length = 0;
        takeBack("m1");
        hold("end m1");

        const round = rig.round();

        await settle();

        const ended = rig.machine.end("m1");

        await settle();
        go("end m1");
        await all([ended, round]);

        expect(events).toEqual(["machine:lost m1"]);
        expect(ends).toEqual(["m1"]);
        expect(machines).toHaveLength(1);
    });

    it("does not find again a machine the app made and ended while the round ran", async () => {
        const { rig, hold, go, takeBack } = await opened();

        await rig.machine.create("d");
        hold("list");

        const round = rig.round();

        await settle();
        await rig.machine.create("d");
        takeBack("m1");
        hold("end m1");
        go("list");
        await settle();
        await rig.machine.end("m2");
        go("end m1");
        await round;

        expect(
            (await rig.machine.list()).map((machine) => {
                return machine.id;
            }),
        ).toEqual(["m3"]);
    });

    it("has the worker drop a machine the app ends while the round gives it to the worker, and ends it once", async () => {
        const { rig, events, ends, drops, hold, go } = await opened();
        const machine = await rig.machine.create("j");

        events.length = 0;
        hold("add");

        const round = rig.round();

        await settle();
        await rig.machine.end("m1");
        go("add");
        await round;

        expect(events).toEqual(["machine:ended m1"]);
        expect(ends).toEqual(["m1"]);
        expect(drops).toEqual([machine!.name]);
    });
});
