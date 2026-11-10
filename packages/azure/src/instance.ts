import { randomBytes } from "node:crypto";

import { Arch, Market, type Place, type Spec } from "@diphyx/rig";

import { toAzure } from "./data.js";
import { azureZone } from "./machine.js";
import { shapeOf } from "./shape.js";

/* Ubuntu 24.04, by Canonical's image on the Azure Marketplace. */
const UBUNTU = {
    [Arch.ARM]: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server-arm64", version: "latest" },
    [Arch.X86]: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" },
};

/** Azure names: 64 characters at most; the rig name's random end is kept. */
const LONGEST = 64;

export function azureName(name: string): string {
    return name.length <= LONGEST ? name : `${name.slice(0, LONGEST - 9)}${name.slice(-9)}`;
}

/** Where and as what a machine runs. */
export type Placement = { region: string; subnet: string; nsg: string; key?: string; identity?: string };

/* The kind's image: a resource id, or a `publisher:offer:sku:version` URN. */
function imageOf(image: string): Record<string, string> {
    const [publisher, offer, sku, version] = image.split(":");

    return image.startsWith("/") || !version
        ? { id: image }
        : { publisher: publisher!, offer: offer!, sku: sku!, version };
}

/* The `rig` user: the given SSH key, or a random password kept nowhere. */
function loginOf(key: string | undefined): Record<string, unknown> {
    if (key) {
        return {
            linuxConfiguration: {
                disablePasswordAuthentication: true,
                ssh: { publicKeys: [{ path: "/home/rig/.ssh/authorized_keys", keyData: key }] },
            },
        };
    }

    return { adminPassword: `${randomBytes(24).toString("base64url")}aA1!` };
}

/** §11: one try. `spec.extra` goes first, its `properties` merged, so the one try and the tags always win. */
export function vmBody(place: Place, spec: Spec, vm: string, placement: Placement): Record<string, unknown> {
    const arch = shapeOf(place.type)?.arch ?? Arch.X86;
    const zone = azureZone(placement.region, place.zone);
    const extra = (spec.extra ?? {}) as { properties?: Record<string, unknown> };

    return {
        ...extra,
        location: placement.region,
        ...(zone && { zones: [zone] }),
        tags: toAzure({ ...spec.tags, "rig-name": azureName(spec.tags["rig-name"] ?? spec.name) }),
        ...(placement.identity && {
            identity: { type: "UserAssigned", userAssignedIdentities: { [placement.identity]: {} } },
        }),
        properties: {
            ...extra.properties,
            hardwareProfile: { vmSize: place.type },
            storageProfile: {
                imageReference: spec.image ? imageOf(spec.image) : UBUNTU[arch],
                osDisk: {
                    createOption: "FromImage",
                    deleteOption: "Delete",
                    ...(spec.disk !== undefined && { diskSizeGB: spec.disk }),
                },
            },
            osProfile: {
                computerName: vm,
                adminUsername: "rig",
                ...loginOf(placement.key),
                ...(spec.script !== undefined && { customData: Buffer.from(spec.script).toString("base64") }),
            },
            networkProfile: {
                networkApiVersion: "2020-11-01",
                networkInterfaceConfigurations: [
                    {
                        name: `${vm}-nic`,
                        properties: {
                            primary: true,
                            deleteOption: "Delete",
                            networkSecurityGroup: { id: placement.nsg },
                            ipConfigurations: [
                                {
                                    name: "ip",
                                    properties: {
                                        subnet: { id: placement.subnet },
                                        publicIPAddressConfiguration: {
                                            name: `${vm}-ip`,
                                            sku: { name: "Standard" },
                                            properties: { deleteOption: "Delete", publicIPAllocationMethod: "Static" },
                                        },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            ...(place.market === Market.SPOT && {
                priority: "Spot",
                evictionPolicy: "Delete",
                billingProfile: { maxPrice: -1 },
            }),
        },
    };
}
