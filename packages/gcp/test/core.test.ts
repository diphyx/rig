import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRig, Market } from "@diphyx/rig";

import { DONE, gcp, REGION } from "./fake.js";

describe("gcp: with the core", () => {
    it("takes a full spot quota as no room in spot, and makes the machine on demand", async () => {
        const { provider } = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return { items: { "zones/us-central1-a": { machineTypes: [{ name: "c4a-standard-8" }] } } };
            },
            "GET projects/p/aggregated/instances": () => {
                return { items: {} };
            },
            "POST projects/p/zones/us-central1-a/instances": (body) => {
                return body?.scheduling
                    ? {
                          status: "DONE",
                          error: { errors: [{ code: "QUOTA_EXCEEDED", message: "Quota 'PREEMPTIBLE_CPUS' exceeded" }] },
                      }
                    : { status: "DONE" };
            },
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [
                {
                    name: "w",
                    try: [{ provider: "gcp", market: [Market.SPOT, Market.DEMAND], types: ["c4a-standard-8"] }],
                },
            ],
            store: mkdtempSync(join(tmpdir(), "rig-gcp-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(await rig.machine.create("w")).toMatchObject({ market: "demand" });
    });

    it("checks at open, and creates a machine from a preset", async () => {
        const { provider, calls } = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return { items: { "zones/us-central1-a": { machineTypes: [{ name: "t2a-standard-1" }] } } };
            },
            "GET projects/p/aggregated/instances": () => {
                return { items: {} };
            },
            "POST projects/p/zones/us-central1-a/instances": DONE,
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [provider.presets.small({ name: "dev" })],
            store: mkdtempSync(join(tmpdir(), "rig-gcp-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(calls[0]!.path).toBe("projects/p/regions/us-central1");

        expect(await rig.machine.create("dev")).toMatchObject({
            provider: "gcp",
            kind: "dev",
            market: "demand",
            zone: "us-central1-a",
        });
    });
});
