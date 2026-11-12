import { randomBytes } from "node:crypto";

import { Slot, type Worker } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { createGrid } from "../../packages/grid/src/index.js";

/* A hub's IP, from the range kept for docs: these checks never dial it. */
const IP = "203.0.113.9";

/* Every official worker, made at a given IP and with its own key: these checks never reach a machine. */
const WORKERS = [
    {
        name: "grid",
        /* A kind's `worker`, as this one takes it. */
        kind: { tags: ["build"], cmds: { make: { exec: ["make"] } } },
        make: (config: Record<string, unknown> = {}): Worker => {
            return createGrid({ ip: IP, identity: randomBytes(32).toString("base64"), ...config });
        },
    },
];

describe.each(WORKERS)("worker $name", ({ name, kind, make }) => {
    it("is a rig 1 worker of the same shape: slot, name, every call", () => {
        const worker = make();

        expect(worker).toMatchObject({ slot: Slot.WORKER, name, rig: 1 });

        for (const call of ["check", "setup", "add", "drop", "spent"]) {
            expect(typeof (worker as unknown as Record<string, unknown>)[call], call).toBe("function");
        }
    });

    it("takes its name", () => {
        expect(make({ name: `${name}-eu` }).name).toBe(`${name}-eu`);
    });

    it("checks a kind's worker: its own passes; a key it does not know throws, naming it, for the core's refusal", () => {
        const worker = make();

        expect(() => {
            worker.check(kind);
        }).not.toThrow();

        expect(() => {
            worker.check({ ...kind, unknown: true });
        }).toThrow(/unknown/);
    });

    it("sets up a machine at its create: first-boot lines, a port open to its own IP, and a key for it", async () => {
        const worker = make();

        await worker.open?.();

        const setup = worker.setup({ name: "app-w-1", tags: kind.tags, worker: kind });

        expect(setup.script.length).toBeGreaterThan(0);
        expect(setup.key).not.toBe("");

        expect(setup.ports.length).toBeGreaterThan(0);

        for (const rule of setup.ports) {
            expect(rule.from).toBe(`${IP}/32`);
        }

        /* Each machine its own key. */
        expect(worker.setup({ name: "app-w-2", tags: kind.tags, worker: kind }).key).not.toBe(setup.key);
    });
});
