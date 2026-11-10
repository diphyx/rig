import { Arch, Market, type Place, type Spec } from "@diphyx/rig";

import { toGcp } from "./data.js";
import { shapeOf } from "./shape.js";

/* Ubuntu 24.04, by Canonical's image family. */
const UBUNTU = {
    [Arch.ARM]: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-arm64",
    [Arch.X86]: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
};

/** Compute Engine names: 63 lower-case characters at most; the rig name's random end is kept. */
const LONGEST = 63;

export function gceName(name: string): string {
    return name.length <= LONGEST ? name : `${name.slice(0, LONGEST - 9)}${name.slice(-9)}`;
}

/** Where and as what an instance runs. */
export type Placement = { network: string; subnet?: string; identity?: string };

/** §11: one try. `spec.extra` goes first, so the one try and the tags always win. */
export function instanceBody(
    place: Place,
    spec: Spec,
    instance: string,
    placement: Placement,
): Record<string, unknown> {
    const arch = shapeOf(place.type)?.arch ?? Arch.X86;

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
                    sourceImage: spec.image ?? UBUNTU[arch],
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
        ...(spec.script !== undefined && { metadata: { items: [{ key: "startup-script", value: spec.script }] } }),
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
