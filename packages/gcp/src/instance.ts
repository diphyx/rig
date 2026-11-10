import { Market, type Place, type Spec } from "@diphyx/rig";

import { toGcp } from "./data.js";

/** Compute Engine names: 63 lower-case characters at most; the rig name's random end is kept. */
const LONGEST = 63;

export function gceName(name: string): string {
    return name.length <= LONGEST ? name : `${name.slice(0, LONGEST - 9)}${name.slice(-9)}`;
}

/** Where and as what an instance runs. */
export type Placement = { network: string; subnet?: string; identity?: string };

/** The image to boot: its link, and how the machine shows it, under its metadata's `rig-image`. */
export type Boot = { link: string; image: string };

/** The metadata key a machine's image is kept under. */
export const IMAGE = "rig-image";

/* The entry's own metadata items, but those rig sets. */
function ownItems(extra: Spec["extra"]): { key: string; value: string }[] {
    const items = (extra as { metadata?: { items?: { key: string; value: string }[] } } | undefined)?.metadata?.items;

    return (items ?? []).filter((item) => {
        return item.key !== IMAGE && item.key !== "startup-script";
    });
}

/** §11: one try. `spec.extra` goes first, so the one try and the tags always win. */
export function instanceBody(
    place: Place,
    spec: Spec,
    instance: string,
    boot: Boot,
    placement: Placement,
): Record<string, unknown> {
    return {
        ...spec.extra,
        name: instance,
        machineType: `zones/${place.zone}/machineTypes/${place.type}`,
        labels: toGcp({ ...spec.tags, "rig-name": gceName(spec.tags["rig-name"] ?? spec.name) }),
        tags: { items: [instance] },
        disks: [
            {
                boot: true,
                autoDelete: true,
                initializeParams: {
                    sourceImage: boot.link,
                    ...(spec.disk !== undefined && { diskSizeGb: String(spec.disk) }),
                },
            },
        ],
        networkInterfaces: [
            {
                network: placement.network,
                ...(placement.subnet && { subnetwork: placement.subnet }),
                accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }],
            },
        ],
        metadata: {
            ...(spec.extra as { metadata?: object } | undefined)?.metadata,
            items: [
                ...ownItems(spec.extra),
                { key: IMAGE, value: boot.image },
                ...(spec.script !== undefined ? [{ key: "startup-script", value: spec.script }] : []),
            ],
        },
        ...(place.market === Market.SPOT && {
            scheduling: { provisioningModel: "SPOT", instanceTerminationAction: "DELETE" },
        }),
        ...(placement.identity && {
            serviceAccounts: [
                { email: placement.identity, scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
            ],
        }),
    };
}
