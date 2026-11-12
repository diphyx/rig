import { describe, expect, it } from "vitest";

import { Market } from "@diphyx/rig";

import { cleanEach, ok, failed, azure } from "./fake.js";

cleanEach();

describe("azure: shapes", () => {
    const { provider } = azure({});

    it("reads a size's shape from its name and the data file: p is arm, l is low memory", async () => {
        expect(await provider.shape!("Standard_D4ps_v6")).toEqual({ cpu: 4, mem: 16, arch: "arm" });
        expect(await provider.shape!("Standard_D4pls_v6")).toEqual({ cpu: 4, mem: 8, arch: "arm" });
        expect(await provider.shape!("Standard_F8s_v2")).toEqual({ cpu: 8, mem: 16, arch: "x86" });
        expect(await provider.shape!("Standard_E8as_v5")).toEqual({ cpu: 8, mem: 64, arch: "x86" });
        expect(await provider.shape!("Standard_NC4as_T4_v3")).toEqual({ cpu: 4, mem: 28, gpu: "t4", arch: "x86" });
        expect(await provider.shape!("Standard_M128s")).toBeNull();
    });

    it("makes the same five presets: arm first, then x86", () => {
        expect(provider.presets.compute({ name: "w" }).try[0]).toEqual({
            provider: "azure",
            market: [Market.SPOT, Market.DEMAND],
            types: ["Standard_D4pls_v6", "Standard_D4pls_v5", "Standard_F4as_v6", "Standard_F4s_v2"],
        });

        expect(provider.presets.gpu({ name: "t" }).try[0]!.types).toEqual([
            "Standard_NC4as_T4_v3",
            "Standard_NC8as_T4_v3",
        ]);
    });

    it("takes a size with no zone info as one place, and skips only the zones a restriction names", async () => {
        const { provider } = azure({
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_D4ps_v6",
                            restrictions: [{ type: "Zone" }, {}],
                        },
                        { resourceType: "virtualMachines" },
                    ],
                });
            },
        });

        expect(
            await provider.places({ provider: "azure", market: [Market.DEMAND], types: ["Standard_D4ps_v6", ""] }),
        ).toEqual([
            { market: Market.DEMAND, type: "Standard_D4ps_v6", zone: "eastus" },
            { market: Market.DEMAND, type: "", zone: "eastus" },
        ]);
    });

    it("reads the sizes again after a read that fails", async () => {
        let reads = 0;

        const { provider } = azure({
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                reads += 1;

                return reads === 1 ? failed(500, "InternalServerError") : ok({ value: [] });
            },
        });

        const entry = { provider: "azure", market: [Market.DEMAND], types: ["Standard_D4ps_v6"] };

        await expect(provider.places(entry)).rejects.toThrow("InternalServerError");
        expect(await provider.places(entry)).toEqual([]);
        expect(reads).toBe(2);
    });

    it("has no shape for a name outside the Standard_ families", async () => {
        expect(await azure({}).provider.shape!("Basic_A1")).toBeNull();
    });
});
