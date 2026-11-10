import { type Busy, createDistroTable, createTagMap, type DistroTable, type PresetTable } from "@diphyx/rig";

import data from "./aws.json" with { type: "json" };

/** §12: the data file, read once. */
export const RIG = data.rig;
export const PRESETS = data.presets as PresetTable;

/** What `shape` reads: memory per vCPU by class, GPU families, burstable sizes. */
export const SHAPES = data.shapes as {
    memory: Record<string, number>;
    families: Record<string, { memory: number; gpu: string }>;
    burstable: Record<string, { cpu: number; mem: number }>;
};

/** §12: where a distro's newest image is: its publisher's public SSM parameter, with the image's root device. */
export type AwsImage = { ssm: string; root: string };

/** §12: the distro table: the versions aws offers, and each one's pointer. */
export const DISTROS = createDistroTable("aws", data.distros as DistroTable<AwsImage>);

/** The root device of an SSM parameter the table names; `/dev/sda1` for any other. */
export function ssmRootOf(image: string): string {
    const pointers = Object.values(data.distros as DistroTable<AwsImage>).flatMap((versions) => {
        return Object.values(versions).flatMap((arches) => {
            return Object.values(arches);
        });
    });

    return (
        pointers.find((pointer) => {
            return `resolve:ssm:${pointer.ssm}` === image;
        })?.root ?? "/dev/sda1"
    );
}

const BUSY = data.busy as Record<string, Busy>;
const TAGS = createTagMap(data.tags as Record<string, string>);

/** The busy answer for an AWS error code; none means it is not about room. */
export function busyOf(code: string): Busy | undefined {
    return BUSY[code];
}

/** §12: rig's tag names onto names aws can hold. */
export const toAws = TAGS.to;

/** §12: aws's tag names back onto rig's, so the core only sees its own. */
export const fromAws = TAGS.from;
