import { describe, expect, it } from "vitest";

import {
    Arch,
    createDistroTable,
    createPresets,
    Distro,
    Market,
    PresetArch,
    type PresetTable,
    Reason,
    Refusal,
} from "../src/index.js";

/* A provider's preset table: arm and x86 types by size, some sizes sold on one arch only. */
const TABLE: PresetTable = {
    small: { arm: ["s-arm"], x86: ["s-x86"] },
    general: {
        arm: { "2": ["g2-arm"], "4": ["g4-arm"], "8": ["g8-arm"] },
        x86: { "2": ["g2-x86", "shared"], "4": ["g4-x86", "shared"] },
    },
    compute: { x86: { "4": ["c4-x86"], "16": ["c16-x86"] } },
    memory: { arm: { "32": ["m32-arm"] }, x86: { "64": ["m64-x86"] } },
    gpu: { x86: { l4: ["gpu-l4"], h100: ["gpu-h100"] } },
};

const presets = createPresets("mine", TABLE);

/* The refusal a call throws, to read its reason and message. */
function refusalOf(call: () => unknown): Refusal {
    try {
        call();
    } catch (error) {
        expect(error).toBeInstanceOf(Refusal);

        return error as Refusal;
    }

    throw new Error("no refusal");
}

describe("presets", () => {
    it("makes a small kind of both arches, arm first, on demand, with a 30 GB disk", () => {
        expect(presets.small({ name: "box" })).toEqual({
            name: "box",
            disk: 30,
            try: [{ provider: "mine", market: [Market.DEMAND], types: ["s-arm", "s-x86"] }],
        });
    });

    it("makes a general kind of the default size, each type once, the disk from its cpu", () => {
        expect(presets.general({ name: "app" })).toEqual({
            name: "app",
            disk: 40,
            try: [{ provider: "mine", market: [Market.DEMAND], types: ["g2-arm", "g2-x86", "shared"] }],
        });
    });

    it("rounds a size not sold up to the next one, and tries `up` more sizes after it", () => {
        expect(presets.general({ name: "app", cpu: 3 }).try[0]!.types).toEqual(["g4-arm", "g4-x86", "shared"]);

        expect(presets.general({ name: "app", cpu: 2, up: 2 }).try[0]!.types).toEqual([
            "g2-arm",
            "g2-x86",
            "shared",
            "g4-arm",
            "g4-x86",
            "g8-arm",
        ]);
    });

    it("makes a compute kind spot first, from the arch that sells it", () => {
        expect(presets.compute({ name: "work", cpu: 8 })).toEqual({
            name: "work",
            disk: 70,
            try: [{ provider: "mine", market: [Market.SPOT, Market.DEMAND], types: ["c16-x86"] }],
        });
    });

    it("makes a memory kind, its disk from its memory", () => {
        expect(presets.memory({ name: "cache" })).toMatchObject({
            disk: 50,
            try: [{ types: ["m32-arm", "m64-x86"] }],
        });

        expect(presets.memory({ name: "cache", mem: 64, arch: PresetArch.X86 })).toMatchObject({
            disk: 70,
            try: [{ types: ["m64-x86"] }],
        });
    });

    it("makes a gpu kind of the model asked, else the first model sold, with a 200 GB disk", () => {
        expect(presets.gpu({ name: "train", gpu: "h100" })).toEqual({
            name: "train",
            disk: 200,
            try: [{ provider: "mine", market: [Market.SPOT, Market.DEMAND], types: ["gpu-h100"] }],
        });

        expect(presets.gpu({ name: "train" }).try[0]!.types).toEqual(["gpu-l4"]);
    });

    it("takes one arch when asked, and the market and kind keys as given", () => {
        expect(
            presets.small({
                name: "box",
                arch: PresetArch.ARM,
                market: [Market.SPOT],
                disk: 60,
                life: "1h",
                tags: { team: "a" },
            }),
        ).toEqual({
            name: "box",
            disk: 60,
            life: "1h",
            tags: { team: "a" },
            try: [{ provider: "mine", market: [Market.SPOT], types: ["s-arm"] }],
        });

        expect(presets.small({ name: "box", arch: PresetArch.ANY }).try[0]!.types).toEqual(["s-arm", "s-x86"]);
    });

    it("puts an image on the entry, without a disk, on arm when arm is sold, else on x86", () => {
        expect(presets.general({ name: "app", image: "img-1" })).toEqual({
            name: "app",
            try: [{ provider: "mine", market: [Market.DEMAND], types: ["g2-arm"], image: "img-1" }],
        });

        expect(presets.compute({ name: "work", image: "img-1" }).try[0]!.types).toEqual(["c4-x86"]);
        expect(presets.small({ name: "box", image: "img-1", arch: PresetArch.X86 }).try[0]!.types).toEqual(["s-x86"]);
    });

    it("refuses a preset without a name, an option it does not take, or an image with a distro or arch any", () => {
        expect(
            refusalOf(() => {
                return presets.small({} as never);
            }),
        ).toMatchObject({ reason: Reason.CONFIG, message: "preset small: a name is required" });

        expect(
            refusalOf(() => {
                return presets.compute({ name: "work", mem: 8 } as never);
            }).message,
        ).toBe("preset compute: mem is not an option of this preset");

        expect(
            refusalOf(() => {
                return presets.gpu({ name: "train", up: 1 } as never);
            }).message,
        ).toBe("preset gpu: up is not an option of this preset");

        expect(
            refusalOf(() => {
                return presets.small({ name: "box", image: "img-1", distro: { name: Distro.UBUNTU } });
            }).message,
        ).toBe("preset small: image with distro: the image is booted in place of it");

        expect(
            refusalOf(() => {
                return presets.small({ name: "box", image: "img-1", arch: PresetArch.ANY });
            }).message,
        ).toBe("preset small: arch any with an image: an image fits one arch");
    });

    it("refuses a size, a model or an arch the provider does not sell", () => {
        expect(
            refusalOf(() => {
                return presets.general({ name: "app", cpu: 64 });
            }).message,
        ).toBe("preset general: nothing sold for cpu 64");

        expect(
            refusalOf(() => {
                return presets.gpu({ name: "train", gpu: "a10" });
            }).message,
        ).toBe("preset gpu: nothing sold for gpu a10");

        expect(
            refusalOf(() => {
                return presets.compute({ name: "work", arch: PresetArch.ARM });
            }).message,
        ).toBe("preset compute: nothing sold for cpu 4");

        expect(
            refusalOf(() => {
                return createPresets("bare", {}).small({ name: "box" });
            }).message,
        ).toBe("preset small: nothing sold for it");

        expect(
            refusalOf(() => {
                return createPresets("bare", { gpu: { arm: {} } }).gpu({ name: "train" });
            }).message,
        ).toBe("preset gpu: nothing sold for gpu ");
    });

    it("takes a size key as its number, and a size it cannot find as none sold", () => {
        const odd = createPresets("odd", { general: { x86: { "2.0": ["g2-x86"], "4": ["g4-x86"] } } });

        expect(odd.general({ name: "app", up: 1 }).try[0]!.types).toEqual(["g4-x86"]);
    });
});

describe("distro table", () => {
    const table = createDistroTable("mine", {
        [Distro.UBUNTU]: { "24.04": { [Arch.ARM]: "u24-arm", [Arch.X86]: "u24-x86" } },
        [Distro.DEBIAN]: { "12": { [Arch.X86]: "d12-x86" } as Record<Arch, string> },
    });

    it("offers each distro's versions, as the table names them", () => {
        expect(table.offers).toEqual({ [Distro.UBUNTU]: ["24.04"], [Distro.DEBIAN]: ["12"] });
    });

    it("gives the pointer for a distro on an arch, and throws for one it does not hold", () => {
        expect(table.pointerOf({ name: Distro.UBUNTU, version: "24.04" }, Arch.ARM)).toBe("u24-arm");

        expect(() => {
            return table.pointerOf({ name: Distro.DEBIAN, version: "12" }, Arch.ARM);
        }).toThrow("mine: no debian 12 image for arm");

        expect(() => {
            return table.pointerOf({ name: Distro.DEBIAN, version: "13" }, Arch.X86);
        }).toThrow("mine: no debian 13 image for x86");

        expect(() => {
            return createDistroTable<string>("bare", {}).pointerOf({ name: Distro.UBUNTU, version: "24.04" }, Arch.X86);
        }).toThrow("bare: no ubuntu 24.04 image for x86");
    });
});
