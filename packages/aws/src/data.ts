import type { Busy, PresetTable, Tags } from "@diphyx/rig";

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

const BUSY = data.busy as Record<string, Busy>;
const TAGS = data.tags as Record<string, string>;

const BACK = Object.fromEntries(
    Object.entries(TAGS).map(([rig, aws]) => {
        return [aws, rig];
    }),
);

/** The busy answer for an AWS error code; none means it is not about room. */
export function busyOf(code: string): Busy | undefined {
    return BUSY[code];
}

/** §12: rig's tag names onto names AWS can hold. */
export function toAws(tags: Tags): Tags {
    return Object.fromEntries(
        Object.entries(tags).map(([name, value]) => {
            return [TAGS[name] ?? name, value];
        }),
    );
}

/** §12: AWS's tag names back onto rig's, so the core only sees its own. */
export function fromAws(tags: Tags): Tags {
    return Object.fromEntries(
        Object.entries(tags).map(([name, value]) => {
            return [BACK[name] ?? name, value];
        }),
    );
}
