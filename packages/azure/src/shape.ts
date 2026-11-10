import { Arch, type Shape } from "@diphyx/rig";

import { SHAPES } from "./data.js";

/* Standard_ family vCPUs features _v version: `Standard_D4ps_v6`, `Standard_F8s_v2`, `Standard_E16as_v5`. */
const SIZE = /^Standard_([A-Z]+)(\d+)([a-z]*)(?:_v\d+)?$/;

/** §9, §15: a type's shape, read from its name and the data file; `p` is arm, `l` is low memory. */
export function shapeOf(type: string): Shape | null {
    const fixed = SHAPES.fixed[type];

    if (fixed) {
        return {
            cpu: fixed.cpu,
            mem: fixed.mem,
            ...(fixed.gpu && { gpu: fixed.gpu }),
            arch: fixed.arm ? Arch.ARM : Arch.X86,
        };
    }

    const match = SIZE.exec(type);

    if (!match) {
        return null;
    }

    const [, family = "", cpus = "", features = ""] = match;
    const ratio = features.includes("l") ? SHAPES.low : SHAPES.memory[family];

    if (ratio === undefined) {
        return null;
    }

    const cpu = Number(cpus);

    return { cpu, mem: Math.round(cpu * ratio), arch: features.includes("p") ? Arch.ARM : Arch.X86 };
}
