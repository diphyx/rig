import { type Busy, createTagMap, type PresetTable } from "@diphyx/rig";

import data from "./azure.json" with { type: "json" };

/** §12: the data file, read once. */
export const RIG = data.rig;
export const PRESETS = data.presets as PresetTable;

/** What `shape` reads: memory per vCPU by family, the low-memory ratio, and fixed sizes. */
export const SHAPES = data.shapes as {
    memory: Record<string, number>;
    low: number;
    fixed: Record<string, { cpu: number; mem: number; gpu?: string; arm?: boolean }>;
};

const BUSY = data.busy as Record<string, Busy>;
const TAGS = createTagMap(data.tags as Record<string, string>);

/** The busy answer for an Azure error code; none means it is not about room. */
export function busyOf(code: string): Busy | undefined {
    return BUSY[code];
}

/** §12: rig's tag names onto names azure can hold. */
export const toAzure = TAGS.to;

/** §12: azure's tag names back onto rig's, so the core only sees its own. */
export const fromAzure = TAGS.from;
