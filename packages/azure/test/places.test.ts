import { describe, expect, it } from "vitest";

import { Market } from "@diphyx/rig";

import { cleanEach, ok, azure } from "./fake.js";

cleanEach();

describe("azure: places", () => {
    it("gives each size's open zones in the region, a region without zones as one place, once per market", async () => {
        const { provider } = azure({
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_D4ps_v6",
                            locationInfo: [{ zones: ["3", "1", "2"] }],
                            restrictions: [{ type: "Zone", restrictionInfo: { zones: ["2"] } }],
                        },
                        { resourceType: "virtualMachines", name: "Standard_F4s_v2", locationInfo: [{ zones: [] }] },
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_E4s_v5",
                            restrictions: [{ type: "Location" }],
                        },
                        { resourceType: "disks", name: "Standard_D4ps_v6" },
                    ],
                });
            },
        });

        expect(
            await provider.places({
                provider: "azure",
                market: [Market.SPOT],
                types: ["Standard_D4ps_v6", "Standard_F4s_v2", "Standard_E4s_v5"],
            }),
        ).toEqual([
            { market: Market.SPOT, type: "Standard_D4ps_v6", zone: "eastus-1" },
            { market: Market.SPOT, type: "Standard_D4ps_v6", zone: "eastus-3" },
            { market: Market.SPOT, type: "Standard_F4s_v2", zone: "eastus" },
        ]);
    });
});
