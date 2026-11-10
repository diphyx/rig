import {
    type Answer,
    Arch,
    Busy,
    createPresets,
    regionOf,
    type Place,
    type Presets,
    type Provider,
    type ProviderMachine,
    Reason,
    Refusal,
    type Shape,
    Slot,
    type Spec,
    type Tags,
} from "@diphyx/rig";

import { all, tryit } from "radash";

import { codeOf, createArm, gone } from "./arm.js";
import { KEYS, resolveAuth } from "./auth.js";
import { type AzureConfig, checkConfig, subscriptionOf } from "./config.js";
import { busyOf, DISTROS, PRESETS, REGION, RIG } from "./data.js";
import { createDisk } from "./disk.js";
import { azureName, referenceOf, vmBody } from "./instance.js";
import { toMachine, type Vm } from "./machine.js";
import { createNetwork } from "./network.js";
import { API, paths, versioned } from "./paths.js";
import { createPorts } from "./ports.js";
import { shapeOf } from "./shape.js";
import { createSizes } from "./sizes.js";

export type Azure = Provider & { keys: string[]; presets: Presets };

/* Image versions, newest first: `1.10.0` above `1.9.0`. */
function newerFirst(a: string, b: string): number {
    const [x, y] = [a, b].map((one) => {
        return one.split(".").map(Number);
    }) as [number[], number[]];

    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const step = (y[i] ?? 0) - (x[i] ?? 0);

        if (step !== 0) {
            return step;
        }
    }

    return 0;
}

/** The azure provider: Virtual Machines, `spot` and `demand`, in one region. */
export function createAzure(config: AzureConfig = {}): Azure {
    checkConfig(config);

    const subscription = subscriptionOf(config);
    const name = config.name ?? "azure";
    const extra = config.extra ?? {};
    const region = regionOf(config.region, REGION.env, REGION.default);
    const arm = createArm(resolveAuth(name, config.auth), extra.request);
    const path = paths(subscription, extra.group ?? "rig");
    const network = createNetwork(arm, path, region, extra.subnet);
    const ports = createPorts(arm, path, region);
    const sizes = createSizes(arm, path, region);

    /* The machine deleted, with its disk, card and IP; one already gone is done. */
    async function remove(vm: string): Promise<void> {
        try {
            await arm.done("DELETE", versioned(path.vm(vm), API.compute));
        } catch (error) {
            if (!gone(error)) {
                throw error;
            }
        }
    }

    async function vmOf(vm: string): Promise<Vm | null> {
        try {
            return (await arm.send("GET", `${versioned(path.vm(vm), API.compute)}&$expand=instanceView`)).body as Vm;
        } catch (error) {
            if (gone(error)) {
                return null;
            }

            throw error;
        }
    }

    /* The machine's addresses, from its network card and public IP. */
    async function ipOf(vm: Vm): Promise<{ public?: string; private?: string }> {
        const nic = vm.properties?.networkProfile?.networkInterfaces?.[0]?.id;

        if (!nic) {
            return {};
        }

        const card = (await arm.send("GET", versioned(nic, API.network))).body as {
            properties?: {
                ipConfigurations?: { properties?: { privateIPAddress?: string; publicIPAddress?: { id?: string } } }[];
            };
        };

        const config = card.properties?.ipConfigurations?.[0]?.properties;
        const pip = config?.publicIPAddress?.id;
        const address = pip
            ? ((await arm.send("GET", versioned(pip, API.network))).body as { properties?: { ipAddress?: string } })
                  .properties?.ipAddress
            : undefined;

        return {
            ...(address && { public: address }),
            ...(config?.privateIPAddress && { private: config.privateIPAddress }),
        };
    }

    /* The machine's network card, by its id in lower case: Azure's ids differ in case from call to call. */
    function nicOf(vm: Vm): string {
        return (vm.properties?.networkProfile?.networkInterfaces?.[0]?.id ?? "").toLowerCase();
    }

    /* §16: every card's addresses in the group, in two calls, for `list`. */
    async function addresses(): Promise<Map<string, { public?: string; private?: string }>> {
        type Card = {
            id?: string;
            properties?: {
                ipConfigurations?: { properties?: { privateIPAddress?: string; publicIPAddress?: { id?: string } } }[];
            };
        };

        const [cards, ips] = await all([
            arm.all<Card>(path.nics).catch(() => {
                return [] as Card[];
            }),
            arm.all<{ id?: string; properties?: { ipAddress?: string } }>(path.ips).catch(() => {
                return [];
            }),
        ]);

        const publics = new Map(
            ips.map((ip) => {
                return [(ip.id ?? "").toLowerCase(), ip.properties?.ipAddress];
            }),
        );

        return new Map(
            cards.map((card) => {
                const config = card.properties?.ipConfigurations?.[0]?.properties;
                const address = publics.get((config?.publicIPAddress?.id ?? "").toLowerCase());

                return [
                    (card.id ?? "").toLowerCase(),
                    {
                        ...(address && { public: address }),
                        ...(config?.privateIPAddress && { private: config.privateIPAddress }),
                    },
                ];
            }),
        );
    }

    /* The size's arch, for its distro image: from the data file, or an error that says how to boot it. */
    function archOf(type: string): Arch {
        const shape = shapeOf(type);

        if (!shape) {
            throw new Error(`azure: ${type} is not in the data file, so its arch is unknown: give its entry an image`);
        }

        return shape.arch;
    }

    async function action(vm: string, verb: "start" | "deallocate" | "restart"): Promise<void> {
        await arm.done("POST", versioned(`${path.vm(vm)}/${verb}`, API.compute));
    }

    /* §11: the image to boot: the entry's as it is, or the newest Marketplace version of the kind's distro, for the size's arch; `null` when the region has none. */
    async function imageOf(place: Place, spec: Spec): Promise<Record<string, string> | null> {
        if (spec.image !== undefined) {
            return referenceOf(spec.image);
        }

        const urn = DISTROS.pointerOf(spec.distro!, archOf(place.type));
        const [publisher = "", offer = "", sku = ""] = urn.split(":");

        let versions: { name?: string }[];

        try {
            versions = (await arm.send("GET", versioned(path.versions(region, urn), API.compute))).body as {
                name?: string;
            }[];
        } catch (error) {
            if (gone(error)) {
                return null;
            }

            throw error;
        }

        const [newest] = versions
            .map((one) => {
                return one.name ?? "";
            })
            .sort(newerFirst);

        return newest === undefined ? null : { publisher, offer, sku, version: newest };
    }

    return {
        slot: Slot.PROVIDER,
        name,
        rig: RIG,
        can: { spot: true, stop: true, disk: true, port: true },
        distros: DISTROS.offers,
        keys: KEYS,
        presets: createPresets(name, PRESETS),

        /** §11: the keys and the subscription work, and the region is one of its own. */
        async check(): Promise<void> {
            await arm.send("GET", path.subscription);

            const locations = await arm.all<{ name?: string }>(path.locations);

            if (
                !locations.some((one) => {
                    return one.name === region;
                })
            ) {
                throw new Error(`azure: ${region} is not a region of the subscription`);
            }
        },

        /** §11: from the size's name and the data file. */
        async shape(type: string): Promise<Shape | null> {
            return shapeOf(type);
        },

        places: sizes.places,

        /** §11: exactly one try, waited for, behind a security group of its own made first; no room is `busy`, by the data file; anything else throws. */
        async create(place: Place, spec: Spec): Promise<Answer> {
            const vm = azureName(spec.name);
            const image = await imageOf(place, spec);

            /* §11: a region without the distro's image for this size's arch has no room for the type. */
            if (!image) {
                return {
                    busy: Busy.TYPE,
                    message: `azure: no ${spec.distro!.name} ${spec.distro!.version} image in ${region}`,
                };
            }

            const subnet = await network.subnet();
            const nsg = await ports.make(vm, spec.ports);

            try {
                await arm.done(
                    "PUT",
                    versioned(path.vm(vm), API.compute),
                    vmBody(place, spec, vm, {
                        image,
                        region,
                        subnet,
                        nsg,
                        ...(config.identity && { identity: config.identity }),
                    }),
                );

                return { ok: { id: vm } };
            } catch (error) {
                /* §11: a failed try leaves nothing it made: a machine Azure kept in a failed state, then its group. */
                await tryit(remove)(vm);
                await tryit(ports.release)(vm);

                const busy = busyOf(codeOf(error), (error as Error).message);

                if (busy) {
                    return { busy, message: (error as Error).message };
                }

                throw error;
            }
        },

        /** §11: an unknown id is `null`; the addresses are read from its network card. */
        async get(id: string): Promise<ProviderMachine | null> {
            const vm = await vmOf(id);

            return vm ? toMachine(vm, await ipOf(vm)) : null;
        },

        /** §11: every machine in the group with all the tags, in this region, every page, with its addresses. */
        async list(tags: Tags): Promise<ProviderMachine[]> {
            let vms: Vm[];

            try {
                vms = await arm.all<Vm>(path.vms);
            } catch (error) {
                if (gone(error)) {
                    return [];
                }

                throw error;
            }

            const ips = await addresses();

            return vms
                .filter((vm) => {
                    return vm.location === region;
                })
                .map((vm) => {
                    return toMachine(vm, ips.get(nicOf(vm)));
                })
                .filter((machine) => {
                    return Object.entries(tags).every(([key, value]) => {
                        return machine.tags[key] === value;
                    });
                });
        },

        /** §11: the machine, its disk, card and IP go together; then its security group, and groups of machines gone earlier. */
        async end(id: string): Promise<void> {
            await remove(id);
            await ports.release(id);

            await ports.sweep(async (vm) => {
                return (await vmOf(vm)) !== null;
            });
        },

        async reboot(id: string): Promise<void> {
            await action(id, "restart");
        },

        async start(id: string): Promise<void> {
            await action(id, "start");
        },

        /** §11: a `spot` machine cannot stop; a demand one is deallocated, so it costs nothing while stopped. */
        async stop(id: string): Promise<void> {
            const vm = await vmOf(id);

            if (vm?.properties?.priority === "Spot") {
                throw new Refusal(Reason.UNSUPPORTED, `${id} is spot: it cannot stop`);
            }

            await action(id, "deallocate");
        },

        disk: createDisk(arm, path),

        port: {
            open: ports.open,
            close: ports.close,
            list: ports.list,
        },
    };
}
