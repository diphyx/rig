import { Market, type ProviderMachine, Status } from "@diphyx/rig";

import { fromGcp } from "./data.js";
import { IMAGE, NAME } from "./instance.js";

/** A Compute Engine instance, as the API gives it. */
export type Instance = {
    name?: string;
    zone?: string;
    status?: string;
    machineType?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
    scheduling?: { provisioningModel?: string };
    networkInterfaces?: { networkIP?: string; accessConfigs?: { natIP?: string }[] }[];
    disks?: { boot?: boolean; source?: string }[];
    tags?: { items?: string[]; fingerprint?: string };
    metadata?: { items?: { key?: string; value?: string }[] };
};

/** §11: Compute Engine's statuses onto rig's; a spot machine taken back is deleted, so it is gone. */
const STATUS: Record<string, Status> = {
    PROVISIONING: Status.PENDING,
    STAGING: Status.PENDING,
    REPAIRING: Status.PENDING,
    RUNNING: Status.RUNNING,
    STOPPING: Status.STOPPING,
    SUSPENDING: Status.STOPPING,
    SUSPENDED: Status.STOPPED,
    TERMINATED: Status.STOPPED,
};

/** The last part of a Compute Engine URL: a zone's, a type's, a disk's name. */
export function last(url: string | undefined): string {
    return (url ?? "").split("/").pop() ?? "";
}

/** A machine's id: its zone and name, as Compute Engine names an instance. */
export function idOf(zone: string, name: string): string {
    return `${zone}/${name}`;
}

/** The zone and name in a machine's id. */
export function partsOf(id: string): { zone: string; name: string } {
    const [zone = "", name = ""] = id.split("/");

    return { zone, name };
}

/** An instance as rig sees it. */
export function toMachine(instance: Instance): ProviderMachine {
    const nic = instance.networkInterfaces?.[0];

    const item = (key: string): string | undefined => {
        return instance.metadata?.items?.find((one) => {
            return one.key === key;
        })?.value;
    };

    const image = item(IMAGE);
    const name = item(NAME);

    const ip = {
        ...(nic?.accessConfigs?.[0]?.natIP && { public: nic.accessConfigs[0].natIP }),
        ...(nic?.networkIP && { private: nic.networkIP }),
    };

    return {
        id: idOf(last(instance.zone), instance.name ?? ""),
        status: STATUS[instance.status ?? ""] ?? Status.PENDING,
        market: instance.scheduling?.provisioningModel === "SPOT" ? Market.SPOT : Market.DEMAND,
        type: last(instance.machineType),
        ...(image && { image }),
        zone: last(instance.zone),
        tags: { ...fromGcp(instance.labels ?? {}), ...(name && { "rig-name": name }) },
        ...(Object.keys(ip).length > 0 && { ip }),
        created: Date.parse(instance.creationTimestamp ?? "") || 0,
    };
}
