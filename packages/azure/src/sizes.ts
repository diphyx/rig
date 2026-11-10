import type { Entry, Place } from "@diphyx/rig";

import type { Arm } from "./arm.js";
import { zoneOf } from "./machine.js";
import type { Paths } from "./paths.js";

/** A size, as the resource SKUs list gives it. */
type Sku = {
    resourceType?: string;
    name?: string;
    locationInfo?: { zones?: string[] }[];
    restrictions?: { type?: string; restrictionInfo?: { zones?: string[] } }[];
};

/* A size's zones open to the subscription; `[undefined]` for a region with no zones; none when the region is closed to it. */
function openZones(sku: Sku): (string | undefined)[] {
    const blocked = sku.restrictions ?? [];

    if (
        blocked.some((one) => {
            return one.type === "Location";
        })
    ) {
        return [];
    }

    const closed = blocked.flatMap((one) => {
        return one.type === "Zone" ? (one.restrictionInfo?.zones ?? []) : [];
    });

    const zones = sku.locationInfo?.[0]?.zones ?? [];

    if (zones.length === 0) {
        return [undefined];
    }

    return zones
        .filter((zone) => {
            return !closed.includes(zone);
        })
        .sort();
}

/** The region's sizes, read once: the places an entry can use. */
export function createSizes(arm: Arm, path: Paths, region: string) {
    let skus: Promise<Sku[]> | null = null;

    function skusOf(): Promise<Sku[]> {
        skus ??= arm.all<Sku>(path.skus(region));

        skus.catch(() => {
            skus = null;
        });

        return skus;
    }

    return {
        /** §11: the entry's sizes, in every zone the subscription may use, once per market. */
        async places(entry: Entry): Promise<Place[]> {
            return (await skusOf())
                .filter((sku) => {
                    return sku.resourceType === "virtualMachines" && entry.types.includes(sku.name ?? "");
                })
                .flatMap((sku) => {
                    return openZones(sku).flatMap((zone) => {
                        return entry.market.map((market) => {
                            return { market, type: sku.name ?? "", zone: zoneOf(region, zone) };
                        });
                    });
                });
        },
    };
}
