import { describe, expect, it } from "vitest";

import { Market } from "@diphyx/rig";

import { GceError } from "../src/index.js";

import { gcp, REGION } from "./fake.js";

describe("gcp: places", () => {
    it("gives the entry's types in the region's zones only, once per market", async () => {
        const { provider } = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return {
                    items: {
                        "zones/us-central1-a": { machineTypes: [{ name: "c4a-standard-8" }] },
                        "zones/europe-west1-b": { machineTypes: [{ name: "c4a-standard-8" }] },
                        "zones/us-central1-b": {},
                    },
                };
            },
        });

        expect(
            await provider.places({ provider: "gcp", market: [Market.SPOT, Market.DEMAND], types: ["c4a-standard-8"] }),
        ).toEqual([
            { market: Market.SPOT, type: "c4a-standard-8", zone: "us-central1-a" },
            { market: Market.DEMAND, type: "c4a-standard-8", zone: "us-central1-a" },
        ]);
    });

    it("finds no places in a region with no zones, and keeps a type with no name as an empty one", async () => {
        const empty = gcp({
            "GET projects/p/regions/us-central1": () => {
                return {};
            },
            "GET projects/p/aggregated/machineTypes": () => {
                return { items: { "zones/us-central1-a": { machineTypes: [{ name: "c4a-standard-8" }] } } };
            },
        });

        expect(
            await empty.provider.places({ provider: "gcp", market: [Market.DEMAND], types: ["c4a-standard-8"] }),
        ).toEqual([]);

        const nameless = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return { items: { "zones/us-central1-a": { machineTypes: [{}] } } };
            },
        });

        expect(
            await nameless.provider.places({ provider: "gcp", market: [Market.DEMAND], types: ["c4a-standard-8"] }),
        ).toEqual([{ market: Market.DEMAND, type: "", zone: "us-central1-a" }]);
    });

    it("asks for the region's zones again after a failed check", async () => {
        let tries = 0;

        const { provider } = gcp({
            "GET projects/p/regions/us-central1": () => {
                tries += 1;

                if (tries === 1) {
                    throw new GceError("backendError", "down");
                }

                return REGION["GET projects/p/regions/us-central1"]();
            },
        });

        await expect(provider.check!()).rejects.toThrow("down");
        await provider.check!();

        expect(tries).toBe(2);
    });
});
