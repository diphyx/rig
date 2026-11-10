import {
    type Answer,
    Arch,
    Busy,
    createPresets,
    type Entry,
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

import { tryit } from "radash";

import { accountOf, KEYS, resolveAuth } from "./auth.js";
import { checkConfig, type GcpConfig } from "./config.js";
import { busyOf, DISTROS, PRESETS, RIG, toGcp } from "./data.js";
import { createDisk } from "./disk.js";
import { codeOf, createGce } from "./gce.js";
import { idOf, type Instance, partsOf, toMachine } from "./machine.js";
import { createPorts } from "./ports.js";
import { type Boot, gceName, instanceBody } from "./instance.js";
import { shapeOf } from "./shape.js";

export type Gcp = Provider & { keys: string[]; presets: Presets };

/** The gcp provider: Compute Engine, `spot` and `demand`, in one region. */
export function createGcp(config: GcpConfig): Gcp {
    checkConfig(config);

    const name = config.name ?? "gcp";
    const extra = config.extra ?? {};
    const keys = resolveAuth(name, config.auth);
    const gce = createGce(keys && accountOf(name, keys), extra.project, extra.request);
    const network = extra.network ?? "global/networks/default";
    const ports = createPorts(gce, network);

    let zones: Promise<string[]> | null = null;

    async function base(zone: string, instance: string): Promise<string> {
        return `projects/${await gce.project()}/zones/${zone}/instances/${instance}`;
    }

    /* The region's zones, found once. */
    function zonesOf(): Promise<string[]> {
        zones ??= gce.project().then(async (project) => {
            const region = (await gce.call("GET", `projects/${project}/regions/${config.region}`)) as {
                zones?: string[];
            };

            return (region.zones ?? []).map((zone) => {
                return zone.split("/").pop() ?? "";
            });
        });

        zones.catch(() => {
            zones = null;
        });

        return zones;
    }

    async function instanceOf(id: string): Promise<Instance | null> {
        const { zone, name: instance } = partsOf(id);

        try {
            return (await gce.call("GET", await base(zone, instance))) as Instance;
        } catch (error) {
            if (codeOf(error) === "notFound") {
                return null;
            }

            throw error;
        }
    }

    /* §11: the image to boot: the entry's as it is, or the newest image of the kind's distro, by its family, for the type's arch. */
    async function imageOf(place: Place, spec: Spec): Promise<Boot | null> {
        if (spec.image !== undefined) {
            return { link: spec.image, image: spec.image };
        }

        const [project, family] = DISTROS.pointerOf(spec.distro!, shapeOf(place.type)?.arch ?? Arch.X86).split("/");
        let found: { name?: string; selfLink?: string };

        try {
            found = (await gce.call("GET", `projects/${project}/global/images/family/${family}`)) as typeof found;
        } catch (error) {
            if (codeOf(error) === "notFound") {
                return null;
            }

            throw error;
        }

        return { link: found.selfLink!, image: `${project}/${found.name}` };
    }

    return {
        slot: Slot.PROVIDER,
        name,
        rig: RIG,
        can: { spot: true, stop: true, disk: true, port: true },
        distros: DISTROS.offers,
        keys: KEYS,
        presets: createPresets(name, PRESETS),

        /** §11: the keys, the project and the region work. */
        async check(): Promise<void> {
            await zonesOf();
        },

        /** §11: from the type's name and the data file. */
        async shape(type: string): Promise<Shape | null> {
            return shapeOf(type);
        },

        /** §11: the entry's types, in every zone of the region that sells them, once per market. */
        async places(entry: Entry): Promise<Place[]> {
            const project = await gce.project();
            const region = await zonesOf();

            const filter = encodeURIComponent(
                entry.types
                    .map((type) => {
                        return `(name = "${type}")`;
                    })
                    .join(" OR "),
            );

            const offered = await gce.all<{ name?: string }>(
                `projects/${project}/aggregated/machineTypes?filter=${filter}`,
                "machineTypes",
            );

            return offered
                .map(({ scope, item }) => {
                    return { zone: scope.replace(/^zones\//, ""), type: item.name ?? "" };
                })
                .filter(({ zone }) => {
                    return region.includes(zone);
                })
                .flatMap(({ zone, type }) => {
                    return entry.market.map((market) => {
                        return { market, type, zone };
                    });
                });
        },

        /** §11: exactly one try, waited for, behind firewall rules of its own made first; no room is `busy`, by the data file; anything else throws. */
        async create(place: Place, spec: Spec): Promise<Answer> {
            const project = await gce.project();
            const instance = gceName(spec.name);
            const id = idOf(place.zone, instance);
            const boot = await imageOf(place, spec);

            /* §11: a region without the distro's image for this type's arch has no room for the type. */
            if (!boot) {
                return {
                    busy: Busy.TYPE,
                    message: `gcp: no ${spec.distro!.name} ${spec.distro!.version} image family`,
                };
            }

            await ports.make(id, spec.ports);

            try {
                await gce.wait(
                    await gce.call(
                        "POST",
                        `projects/${project}/zones/${place.zone}/instances`,
                        instanceBody(place, spec, instance, boot, {
                            network,
                            ...(extra.subnet && { subnet: extra.subnet }),
                            ...(config.identity && { identity: config.identity }),
                        }),
                    ),
                );

                return { ok: { id } };
            } catch (error) {
                /* §11: a failed try leaves nothing it made. */
                await tryit(ports.release)(id);

                const busy = busyOf(codeOf(error));

                if (busy) {
                    return { busy, message: (error as Error).message };
                }

                throw error;
            }
        },

        /** §11: an unknown id is `null`. */
        async get(id: string): Promise<ProviderMachine | null> {
            const instance = await instanceOf(id);

            return instance ? toMachine(instance) : null;
        },

        /** §11: every machine with all the tags, every page; labels without a `-` are filtered by the API too. */
        async list(tags: Tags): Promise<ProviderMachine[]> {
            const project = await gce.project();
            const labels = toGcp(tags);
            const simple = Object.entries(labels).filter(([key]) => {
                return /^[a-z_]+$/.test(key);
            });

            const filter = encodeURIComponent(
                simple
                    .map(([key, value]) => {
                        return `(labels.${key} = "${value}")`;
                    })
                    .join(" AND "),
            );

            const found = await gce.all<Instance>(
                `projects/${project}/aggregated/instances${simple.length > 0 ? `?filter=${filter}` : ""}`,
                "instances",
            );

            const region = await zonesOf();

            /* Aggregated lists span every zone: only this region's are this provider's. */
            return found
                .map(({ item }) => {
                    return toMachine(item);
                })
                .filter((machine) => {
                    return (
                        region.includes(machine.zone) &&
                        Object.entries(tags).every(([key, value]) => {
                            return machine.tags[key] === value;
                        })
                    );
                });
        },

        /** §11: the machine, waited for, then its firewall rules, so it is never open without its deny-all; a gone one still loses its rules. The boot disk goes with it. */
        async end(id: string): Promise<void> {
            const { zone, name: instance } = partsOf(id);

            if (await instanceOf(id)) {
                try {
                    await gce.wait(await gce.call("DELETE", await base(zone, instance)));
                } catch (error) {
                    if (codeOf(error) !== "notFound") {
                        throw error;
                    }
                }
            }

            await ports.release(id);
        },

        async reboot(id: string): Promise<void> {
            const { zone, name: instance } = partsOf(id);

            await gce.wait(await gce.call("POST", `${await base(zone, instance)}/reset`));
        },

        async start(id: string): Promise<void> {
            const { zone, name: instance } = partsOf(id);

            await gce.wait(await gce.call("POST", `${await base(zone, instance)}/start`));
        },

        /** §11: a `spot` machine cannot stop. */
        async stop(id: string): Promise<void> {
            const instance = await instanceOf(id);

            if (instance?.scheduling?.provisioningModel === "SPOT") {
                throw new Refusal(Reason.UNSUPPORTED, `${id} is spot: it cannot stop`);
            }

            const { zone, name: one } = partsOf(id);

            await gce.wait(await gce.call("POST", `${await base(zone, one)}/stop`));
        },

        disk: createDisk(gce),

        port: {
            open: ports.open,
            close: ports.close,
            list: ports.list,
        },
    };
}
