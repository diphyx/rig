import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { all } from "radash";
import { describe, expect, it } from "vitest";

import { createRig, Event, Market, type Provider, type ProviderMachine, Slot, Status } from "../src/index.js";

/* A provider whose `list`, once held, waits until the test lets it go, so a round can be caught mid-list. */
function slow() {
    const machines: ProviderMachine[] = [];
    let gate: Promise<void> | null = null;
    let release: () => void = () => {};
    let lists = 0;

    const provider: Provider = {
        slot: Slot.PROVIDER,
        name: "a",
        rig: 1,
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
                created: 0,
            });

            return { ok: { id } };
        },
        async get(id) {
            return (
                machines.find((one) => {
                    return one.id === id;
                }) ?? null
            );
        },
        async list() {
            lists += 1;

            const now = [...machines];

            await gate;

            return now;
        },
        async end() {},
        async reboot() {},
    };

    return {
        provider,
        hold: () => {
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
        },
        go: () => {
            gate = null;
            release();
        },
        lists: () => {
            return lists;
        },
    };
}

async function opened(provider: Provider) {
    const rig = createRig({
        rig: 1,
        app: "app",
        providers: [provider],
        kinds: [{ name: "d", try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }] }],
        store: mkdtempSync(join(tmpdir(), "rig-rounds-")),
        extra: { rounds: false },
    });

    const lost: string[] = [];

    rig.on(Event.MACHINE_LOST, ({ machine }) => {
        lost.push(machine.id);
    });

    await rig.open();

    return { rig, lost };
}

describe("rounds", () => {
    it("never takes a machine made while a round lists for a lost one", async () => {
        const { provider, hold, go } = slow();
        const { rig, lost } = await opened(provider);

        hold();

        const round = rig.round();
        const machine = await rig.machine.create("d");

        go();
        await round;

        expect(lost).toEqual([]);
        expect(await rig.machine.list()).toMatchObject([{ id: machine!.id }]);
    });

    it("runs one round at a time: a round asked for while one runs is that round", async () => {
        const { provider, hold, go, lists } = slow();
        const { rig } = await opened(provider);
        const before = lists();

        hold();

        const first = rig.round();
        const second = rig.round();

        go();
        await all([first, second]);

        expect(lists() - before).toBe(1);
    });
});
