import { generateKeyPairSync } from "node:crypto";

import { Market, type Place, type Spec } from "@diphyx/rig";

import { toAzure } from "./data.js";
import { azureZone } from "./machine.js";

/** Azure names: 64 characters at most; the rig name's random end is kept. */
const LONGEST = 64;

export function azureName(name: string): string {
    return name.length <= LONGEST ? name : `${name.slice(0, LONGEST - 9)}${name.slice(-9)}`;
}

/** Where and as what a machine runs. */
export type Placement = {
    region: string;
    subnet: string;
    nsg: string;
    /** The image to boot, as an image reference. */
    image: Record<string, string>;
    identity?: string;
};

/** An entry's image, as an image reference: a resource id, or a `publisher:offer:sku:version` URN. */
export function referenceOf(image: string): Record<string, string> {
    const [publisher, offer, sku, version] = image.split(":");

    return image.startsWith("/") || !version
        ? { id: image }
        : { publisher: publisher!, offer: offer!, sku: sku!, version };
}

/* Azure's own admin user, `rig`: SSH by a key whose private half is thrown away, and no password, so no one signs in as it; the kind's `login` signs in (spec §6.2). */
function adminKey(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");

    const part = (bytes: Buffer): Buffer => {
        const size = Buffer.alloc(4);

        size.writeUInt32BE(bytes.length);

        return Buffer.concat([size, bytes]);
    };

    return `ssh-ed25519 ${Buffer.concat([part(Buffer.from("ssh-ed25519")), part(raw)]).toString("base64")}`;
}

/** §11: one try. `spec.extra` goes first, its `properties` merged, so the one try and the tags always win. */
export function vmBody(place: Place, spec: Spec, vm: string, placement: Placement): Record<string, unknown> {
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
                imageReference: placement.image,
                osDisk: {
                    createOption: "FromImage",
                    deleteOption: "Delete",
                    ...(spec.disk !== undefined && { diskSizeGB: spec.disk }),
                },
            },
            osProfile: {
                computerName: vm,
                adminUsername: "rig",
                linuxConfiguration: {
                    disablePasswordAuthentication: true,
                    ssh: { publicKeys: [{ path: "/home/rig/.ssh/authorized_keys", keyData: adminKey() }] },
                },
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
