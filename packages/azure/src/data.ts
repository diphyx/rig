import { type Busy, createDistroTable, createTagMap, type DistroTable, type PresetTable } from "@diphyx/rig";

import data from "./azure.json" with { type: "json" };

/** §12: the data file, read once. */
export const RIG = data.rig;

/** §8.2: where its region comes from, when the config gives none: the first env var set, else the default. */
export const REGION = data.region as { env: string[]; default: string };
export const PRESETS = data.presets as PresetTable;

/** What `shape` reads: memory per vCPU by family, the low-memory ratio, and fixed sizes. */
export const SHAPES = data.shapes as {
    memory: Record<string, number>;
    low: number;
    fixed: Record<string, { cpu: number; mem: number; gpu?: string; arm?: boolean }>;
};

/** §12: the distro table: each version's Marketplace image, as `publisher:offer:sku`; its newest version is taken. */
export const DISTROS = createDistroTable("azure", data.distros as DistroTable<string>);

const BUSY = data.busy as Record<string, Busy>;
const TAGS = createTagMap(data.tags as Record<string, string>);

/** The busy answer for an Azure error code and message; none means it is not about room. */
export function busyOf(code: string, message = ""): Busy | undefined {
    /* `OperationNotAllowed` is a quota only when it says so; Azure uses it for much else. */
    if (code === "OperationNotAllowed" && !/quota/i.test(message)) {
        return undefined;
    }

    return BUSY[code];
}

/** §12: rig's tag names onto names azure can hold. */
export const toAzure = TAGS.to;

/** §12: azure's tag names back onto rig's, so the core only sees its own. */
export const fromAzure = TAGS.from;
