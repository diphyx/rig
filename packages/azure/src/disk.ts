import type { Arm } from "./arm.js";
import type { Vm } from "./machine.js";
import { API, type Paths, versioned } from "./paths.js";

/** A machine's OS disk. */
export function createDisk(arm: Arm, path: Paths) {
    async function diskOf(vm: string): Promise<string> {
        const machine = (await arm.send("GET", versioned(path.vm(vm), API.compute))).body as Vm;
        const id = machine.properties?.storageProfile?.osDisk?.managedDisk?.id;

        if (!id) {
            throw new Error(`azure: ${vm} has no managed OS disk`);
        }

        return id;
    }

    return {
        async grow(vm: string, gb: number): Promise<void> {
            await arm.done("PATCH", versioned(await diskOf(vm), API.disks), { properties: { diskSizeGB: gb } });
        },

        /** Ready once the disk's change has succeeded. */
        async get(vm: string): Promise<{ gb: number; ready: boolean }> {
            const disk = (await arm.send("GET", versioned(await diskOf(vm), API.disks))).body as {
                properties?: { diskSizeGB?: number; provisioningState?: string };
            };

            return { gb: disk.properties?.diskSizeGB ?? 0, ready: disk.properties?.provisioningState === "Succeeded" };
        },
    };
}
