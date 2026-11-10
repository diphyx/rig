import { DescribeVolumesCommand, DescribeVolumesModificationsCommand, ModifyVolumeCommand } from "@aws-sdk/client-ec2";

import { codeOf, type Ec2 } from "./ec2.js";

/** A machine's root disk. */
export function createDisk(ec2: Ec2) {
    async function volumeOf(id: string): Promise<string> {
        const instance = await ec2.instance(id);
        const root = instance?.BlockDeviceMappings?.find((mapping) => {
            return mapping.DeviceName === instance.RootDeviceName;
        });

        if (!root?.Ebs?.VolumeId) {
            throw new Error(`aws: ${id} has no root volume`);
        }

        return root.Ebs.VolumeId;
    }

    return {
        async grow(id: string, gb: number): Promise<void> {
            await ec2.send(new ModifyVolumeCommand({ VolumeId: await volumeOf(id), Size: gb }));
        },

        /** Ready once a size change, if any, is past `modifying`. */
        async get(id: string): Promise<{ gb: number; ready: boolean }> {
            const volume = await volumeOf(id);
            const volumes = await ec2.send<{ Volumes?: { Size?: number }[] }>(
                new DescribeVolumesCommand({ VolumeIds: [volume] }),
            );

            const changes = await ec2
                .send<{ VolumesModifications?: { ModificationState?: string; TargetSize?: number }[] }>(
                    new DescribeVolumesModificationsCommand({ VolumeIds: [volume] }),
                )
                .catch((error: unknown) => {
                    if (codeOf(error) === "InvalidVolumeModification.NotFound") {
                        return { VolumesModifications: [] };
                    }

                    throw error;
                });

            const change = changes.VolumesModifications?.[0];

            return {
                gb: change?.TargetSize ?? volumes.Volumes?.[0]?.Size ?? 0,
                ready: !change || change.ModificationState !== "modifying",
            };
        },
    };
}
