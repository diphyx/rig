import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildBoot } from "../src/boot.js";

import {
    createRig,
    DISTROS,
    Market,
    type Provider,
    type ProviderMachine,
    type RigConfig,
    Slot,
    Status,
    type Worker,
} from "../src/index.js";

/* A provider whose machines run at once, with a private IP; and a worker that keeps what it is asked. */
function world() {
    const machines: ProviderMachine[] = [];
    const adds: { name: string; tags: string[] }[] = [];

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
            machines.push({
                id: `m${machines.length + 1}`,
                status: Status.RUNNING,
                market: place.market,
                type: place.type,
                zone: place.zone,
                tags: spec.tags,
                ip: { private: "10.0.0.1" },
                created: 0,
            });

            return { ok: { id: `m${machines.length}` } };
        },
        async get(id) {
            return (
                machines.find((one) => {
                    return one.id === id;
                }) ?? null
            );
        },
        async list() {
            return [...machines];
        },
        async end() {},
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
        async add(machine: { name: string; tags: string[] }) {
            adds.push(machine);
        },
        async drop() {},
        async spent() {},
    };

    return { provider, worker, adds };
}

describe("workers", () => {
    it("gives every machine with a worker to it again after it opens, with the tags it was made with", async () => {
        const { provider, worker, adds } = world();
        const store = mkdtempSync(join(tmpdir(), "rig-workers-"));

        const config = (tags: string[]): RigConfig => {
            return {
                rig: 1,
                app: "app",
                providers: [provider],
                workers: [worker],
                kinds: [
                    {
                        name: "builder",
                        try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }],
                        worker: { tags },
                    },
                ],
                store,
                extra: { rounds: false },
            };
        };

        const first = createRig(config(["build"]));

        await first.open();

        const machine = await first.machine.create("builder");

        await first.machine.get(machine!.id);
        await first.close();

        /* The kind's tags change: the machine made before keeps its own. */
        const again = createRig(config(["build-v2"]));

        await again.open();

        expect(adds).toMatchObject([
            { name: machine!.name, tags: ["build"] },
            { name: machine!.name, tags: ["build"] },
        ]);

        await again.close();
    });

    it("runs a worker's lines before the kind's script, and its start after it", () => {
        const boot = buildBoot(
            { name: "k", try: [], script: "echo kind" },
            { script: ["echo worker"], start: ["echo start"] },
        )!;

        const worker = boot.indexOf("echo worker");
        const script = boot.indexOf("bash /var/lib/rig/script");

        expect(worker).toBeGreaterThan(-1);
        expect(worker).toBeLessThan(script);
        expect(boot.endsWith("fi\necho start\n")).toBe(true);
    });
});
