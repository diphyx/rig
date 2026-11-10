import { type Busy, createDistroTable, createTagMap, type DistroTable, type PresetTable } from "@diphyx/rig";

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

/** §12: the distro table: each version's image family, as `<project>/<family>`; a family always gives its newest image. */
export const DISTROS = createDistroTable("gcp", data.distros as DistroTable<string>);

const BUSY = data.busy as Record<string, Busy>;
const TAGS = createTagMap(data.tags as Record<string, string>);

/** The busy answer for a Compute Engine error code; none means it is not about room. */
export function busyOf(code: string): Busy | undefined {
    return BUSY[code];
}

/** §12: rig's tag names onto names gcp can hold. */
export const toGcp = TAGS.to;

/** §12: gcp's tag names back onto rig's, so the core only sees its own. */
export const fromGcp = TAGS.from;
