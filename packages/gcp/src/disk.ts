import type { Gce } from "./gce.js";
import { type Instance, last, partsOf } from "./machine.js";

/** A machine's boot disk. */
export function createDisk(gce: Gce) {
    async function diskOf(id: string): Promise<{ path: string }> {
        const project = await gce.project();
        const { zone, name } = partsOf(id);
        const instance = (await gce.call("GET", `projects/${project}/zones/${zone}/instances/${name}`)) as Instance;
        const boot = instance.disks?.find((disk) => {
            return disk.boot;
        });

        if (!boot?.source) {
            throw new Error(`gcp: ${id} has no boot disk`);
        }

        return { path: `projects/${project}/zones/${zone}/disks/${last(boot.source)}` };
    }

    return {
        async grow(id: string, gb: number): Promise<void> {
            const { path } = await diskOf(id);

            await gce.wait(await gce.call("POST", `${path}/resize`, { sizeGb: String(gb) }));
        },

        /** Ready once the disk is `READY`. */
        async get(id: string): Promise<{ gb: number; ready: boolean }> {
            const { path } = await diskOf(id);
            const disk = (await gce.call("GET", path)) as { sizeGb?: string; status?: string };

            return { gb: Number(disk.sizeGb ?? 0), ready: disk.status === "READY" };
        },
    };
}
