import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRig, Market } from "@diphyx/rig";

import { cleanEach, ok, failed, VM, NETWORK, azure } from "./fake.js";

cleanEach();

describe("azure: with the core", () => {
    it("takes a full spot quota as no room in spot, and makes the machine on demand", async () => {
        const { provider } = azure({
            ...NETWORK,
            "GET /subscriptions/s": () => {
                return ok();
            },
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        { resourceType: "virtualMachines", name: "Standard_D4ps_v6", locationInfo: [{ zones: ["1"] }] },
                    ],
                });
            },
            [`GET ${VM}`]: () => {
                return ok({ value: [] });
            },
            [`PUT ${VM}/.*`]: (body) => {
                return (body?.properties as { priority?: string }).priority === "Spot"
                    ? failed(409, "OperationNotAllowed", "QuotaExceeded")
                    : ok();
            },
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [
                {
                    name: "w",
                    try: [{ provider: "azure", market: [Market.SPOT, Market.DEMAND], types: ["Standard_D4ps_v6"] }],
                },
            ],
            store: mkdtempSync(join(tmpdir(), "rig-azure-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(await rig.machine.create("w")).toMatchObject({ market: "demand" });
    });

    it("checks at open, and creates a machine from a preset", async () => {
        const { provider, calls } = azure({
            ...NETWORK,
            "GET /subscriptions/s": () => {
                return ok();
            },
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_B2pls_v2",
                            locationInfo: [{ zones: ["1"] }],
                        },
                    ],
                });
            },
            [`GET ${VM}`]: () => {
                return ok({ value: [] });
            },
            [`PUT ${VM}/.*`]: () => {
                return ok();
            },
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [provider.presets.small({ name: "dev" })],
            store: mkdtempSync(join(tmpdir(), "rig-azure-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(calls[0]!.path).toBe("/subscriptions/s?api-version=2022-12-01");

        expect(await rig.machine.create("dev")).toMatchObject({
            provider: "azure",
            kind: "dev",
            market: "demand",
            zone: "eastus-1",
        });
    });
});
