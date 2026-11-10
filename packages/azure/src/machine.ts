import { Market, type ProviderMachine, Status } from "@diphyx/rig";

import { fromAzure } from "./data.js";

/** A virtual machine, as Azure Resource Manager gives it. */
export type Vm = {
    name?: string;
    location?: string;
    zones?: string[];
    tags?: Record<string, string>;
    properties?: {
        priority?: string;
        timeCreated?: string;
        provisioningState?: string;
        hardwareProfile?: { vmSize?: string };
        storageProfile?: { osDisk?: { managedDisk?: { id?: string } } };
        networkProfile?: { networkInterfaces?: { id?: string }[] };
        instanceView?: { statuses?: { code?: string }[] };
    };
};

/** §11: Azure's power states onto rig's; a spot machine taken back is deleted, so it is gone. */
const POWER: Record<string, Status> = {
    starting: Status.PENDING,
    running: Status.RUNNING,
    stopping: Status.STOPPING,
    deallocating: Status.STOPPING,
    stopped: Status.STOPPED,
    deallocated: Status.STOPPED,
};

/** A place's zone: `eastus-1` for zone 1 of `eastus`; a region with no zones is its own one place. */
export function zoneOf(region: string, zone: string | undefined): string {
    return zone ? `${region}-${zone}` : region;
}

/** The Azure zone in a place's zone: `1` in `eastus-1`; none for a region with no zones. */
export function azureZone(region: string, zone: string): string | undefined {
    return zone === region ? undefined : zone.slice(region.length + 1);
}

function statusOf(vm: Vm): Status {
    if (vm.properties?.provisioningState === "Deleting") {
        return Status.ENDING;
    }

    const power = vm.properties?.instanceView?.statuses
        ?.map((one) => {
            return one.code ?? "";
        })
        .find((code) => {
            return code.startsWith("PowerState/");
        });

    return POWER[power?.slice("PowerState/".length) ?? ""] ?? Status.PENDING;
}

/** A virtual machine as rig sees it; its id is its name, unique in its resource group. */
export function toMachine(vm: Vm, ip?: { public?: string; private?: string }): ProviderMachine {
    const region = vm.location ?? "";

    return {
        id: vm.name ?? "",
        status: statusOf(vm),
        market: vm.properties?.priority === "Spot" ? Market.SPOT : Market.DEMAND,
        type: vm.properties?.hardwareProfile?.vmSize ?? "",
        zone: zoneOf(region, vm.zones?.[0]),
        tags: fromAzure(vm.tags ?? {}),
        ...(ip && Object.keys(ip).length > 0 && { ip }),
        created: Date.parse(vm.properties?.timeCreated ?? "") || 0,
    };
}
