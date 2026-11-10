import { Arch, type Shape } from "@diphyx/rig";

import { SHAPES } from "./data.js";

/* family (class, generation, suffix) . size: `c7gn.2xlarge`, `g4dn.xlarge`, `t4g.small`. */
const TYPE = /^([a-z]+)(\d+)([a-z-]*)\.([a-z0-9]+)$/;
const SIZED = /^(\d*)xlarge$/;

/* vCPUs of a non-burstable size; `metal` and the rest are unknown. */
function cpuOf(size: string): number | null {
    if (size === "medium") {
        return 1;
    }

    if (size === "large") {
        return 2;
    }

    const match = SIZED.exec(size);

    return match ? 4 * Number(match[1] || 1) : null;
}

/** §9, §15: a type's shape, read from its name and the data file. */
export function shapeOf(type: string): Shape | null {
    const match = TYPE.exec(type);

    if (!match) {
        return null;
    }

    const [, group = "", generation = "", suffix = "", size = ""] = match;
    const family = SHAPES.families[`${group}${generation}${suffix}`];
    const arch = suffix.includes("g") ? Arch.ARM : Arch.X86;

    if (group === "t") {
        const burst = SHAPES.burstable[size];

        return burst ? { cpu: burst.cpu, mem: Math.round(burst.mem), arch } : null;
    }

    const cpu = cpuOf(size);
    const memory = family?.memory ?? SHAPES.memory[group[0]!];

    if (cpu === null || memory === undefined) {
        return null;
    }

    return { cpu, mem: Math.round(cpu * memory), ...(family?.gpu && { gpu: family.gpu }), arch };
}
