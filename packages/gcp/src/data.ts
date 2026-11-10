import type { Busy, PresetTable, Tags } from "@diphyx/rig";

import data from "./gcp.json" with { type: "json" };

/** §12: the data file, read once. */
export const RIG = data.rig;
export const PRESETS = data.presets as PresetTable;

/** What `shape` reads: memory per vCPU by class, the arm families, gpu families, and fixed types. */
export const SHAPES = data.shapes as {
    memory: Record<string, number>;
    arm: string[];
    gpu: Record<string, string>;
    fixed: Record<string, { cpu: number; mem: number; gpu?: string }>;
};

const BUSY = data.busy as Record<string, Busy>;
const TAGS = data.tags as Record<string, string>;

const BACK = Object.fromEntries(
    Object.entries(TAGS).map(([rig, gcp]) => {
        return [gcp, rig];
    }),
);

/** The busy answer for a Compute Engine error code; none means it is not about room. */
export function busyOf(code: string): Busy | undefined {
    return BUSY[code];
}

/** §12: rig's tag names onto names GCP can hold. */
export function toGcp(tags: Tags): Tags {
    return Object.fromEntries(
        Object.entries(tags).map(([name, value]) => {
            return [TAGS[name] ?? name, value];
        }),
    );
}

/** §12: GCP's tag names back onto rig's, so the core only sees its own. */
export function fromGcp(tags: Tags): Tags {
    return Object.fromEntries(
        Object.entries(tags).map(([name, value]) => {
            return [BACK[name] ?? name, value];
        }),
    );
}
