import { Arch, type Shape } from "@diphyx/rig";

import { SHAPES } from "./data.js";

/* family - class - vCPUs: `c4a-standard-8`, `n2-highcpu-16`, `g2-standard-4`. */
const TYPE = /^([a-z0-9]+)-([a-z]+)-(\d+)$/;

/** §9, §15: a type's shape, read from its name and the data file. */
export function shapeOf(type: string): Shape | null {
    const family = type.split("-")[0] ?? "";
    const arch = SHAPES.arm.includes(family) ? Arch.ARM : Arch.X86;
    const fixed = SHAPES.fixed[type];

    if (fixed) {
        return { cpu: fixed.cpu, mem: fixed.mem, ...(fixed.gpu && { gpu: fixed.gpu }), arch };
    }

    const match = TYPE.exec(type);
    const memory = match ? SHAPES.memory[match[2] ?? ""] : undefined;

    if (!match || memory === undefined) {
        return null;
    }

    const cpu = Number(match[3]);
    const gpu = SHAPES.gpu[family];

    return { cpu, mem: Math.round(cpu * memory), ...(gpu && { gpu }), arch };
}
