import { describe, expect, it } from "vitest";

import { Market, PresetArch } from "@diphyx/rig";

import { gcp } from "./fake.js";

describe("gcp: shape and presets", () => {
    const { provider } = gcp({});

    it("reads a type's shape from its name and the data file", async () => {
        expect(await provider.shape!("c4a-standard-8")).toEqual({ cpu: 8, mem: 32, arch: "arm" });
        expect(await provider.shape!("n2-highcpu-16")).toEqual({ cpu: 16, mem: 32, arch: "x86" });
        expect(await provider.shape!("e2-small")).toEqual({ cpu: 2, mem: 2, arch: "x86" });
        expect(await provider.shape!("g2-standard-4")).toEqual({ cpu: 4, mem: 16, gpu: "l4", arch: "x86" });
        expect(await provider.shape!("a2-highgpu-1g")).toEqual({ cpu: 12, mem: 85, gpu: "a100", arch: "x86" });
        expect(await provider.shape!("n1-ultramem-40")).toBeNull();
    });

    it("makes the same five presets: arm first, then x86", () => {
        expect(provider.presets.compute({ name: "w" }).try[0]).toEqual({
            provider: "gcp",
            market: [Market.SPOT, Market.DEMAND],
            types: ["c4a-highcpu-4", "c3-highcpu-4", "n2-highcpu-4", "e2-highcpu-4"],
        });

        expect(provider.presets.gpu({ name: "t" }).try[0]!.types).toEqual(["g2-standard-4", "g2-standard-8"]);

        expect(provider.presets.memory({ name: "db", mem: 64, arch: PresetArch.X86 }).try[0]!.types).toEqual([
            "n4-highmem-8",
            "n2-highmem-8",
            "e2-highmem-8",
        ]);
    });
});
