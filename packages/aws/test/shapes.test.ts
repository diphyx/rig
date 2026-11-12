import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRig, Market, PresetArch, Refusal } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { createAws } from "../src/index.js";
import { fake, SUBNETS } from "./fake.js";

describe("aws: shapes", () => {
    const { presets } = createAws({ region: "us-east-1", extra: { client: fake({}).client } });

    const typesOf = (kind: { try: { types: string[] }[] }): string[] => {
        return kind.try[0]!.types;
    };

    it("makes a kind from a name alone: spot first, arm then x86, every family", () => {
        const kind = presets.compute({ name: "worker" });

        expect(kind).toMatchObject({
            name: "worker",
            try: [{ provider: "aws", market: [Market.SPOT, Market.DEMAND] }],
        });

        expect(typesOf(kind)).toEqual([
            "c8g.xlarge",
            "c7g.xlarge",
            "c7gn.xlarge",
            "c6g.xlarge",
            "c6gn.xlarge",
            "c7i.xlarge",
            "c7a.xlarge",
            "c6i.xlarge",
            "c6a.xlarge",
            "c5.xlarge",
        ]);
    });

    it("rounds a size up, and with up, adds bigger sizes only after every type of the asked one", () => {
        expect(typesOf(presets.compute({ name: "w", cpu: 6, arch: PresetArch.ARM }))[0]).toBe("c8g.2xlarge");

        const types = typesOf(presets.general({ name: "g", cpu: 2, up: 1 }));

        expect(types.indexOf("m5.large")).toBeLessThan(types.indexOf("m8g.xlarge"));
        expect(types.at(-1)).toBe("m5.xlarge");
    });

    it("keeps one arch for an image, and refuses any with one", () => {
        const kind = presets.compute({ name: "w", image: "ami-1" });

        expect(
            typesOf(kind).every((type) => {
                return /^c\d+gn?\./.test(type);
            }),
        ).toBe(true);

        expect(() => {
            return presets.compute({ name: "w", image: "ami-1", arch: PresetArch.ANY });
        }).toThrow(Refusal);
    });

    it("picks a gpu by model, the cheapest by default, wherever it is sold", () => {
        expect(typesOf(presets.gpu({ name: "t" }))).toEqual([
            "g5g.xlarge",
            "g5g.2xlarge",
            "g4dn.xlarge",
            "g4dn.2xlarge",
        ]);

        expect(typesOf(presets.gpu({ name: "t", gpu: "l4" }))).toEqual(["g6.xlarge", "g6.2xlarge"]);
    });

    it("passes kind keys on, and takes a market", () => {
        expect(
            presets.memory({ name: "db", mem: 64, market: [Market.SPOT], life: "6h", tags: { team: "x" } }),
        ).toMatchObject({
            life: "6h",
            tags: { team: "x" },
            try: [{ market: [Market.SPOT], types: expect.arrayContaining(["r8g.2xlarge", "r7i.2xlarge"]) }],
        });
    });

    it("refuses a missing name, an option it does not take, and a size not sold", () => {
        const refused = (make: () => unknown): void => {
            expect(make).toThrow(Refusal);
        };

        refused(() => {
            return presets.small({} as never);
        });

        refused(() => {
            return presets.compute({ name: "w", mem: 32 } as never);
        });

        refused(() => {
            return presets.gpu({ name: "t", up: 1 } as never);
        });

        refused(() => {
            return presets.compute({ name: "w", cpu: 1000 });
        });

        refused(() => {
            return presets.gpu({ name: "t", gpu: "tpu" });
        });
    });

    const { shape } = createAws({ region: "us-east-1", extra: { client: fake({}).client } });

    it("reads a type's shape from its name and the data file, with no call", async () => {
        expect(await shape!("c8g.2xlarge")).toEqual({ cpu: 8, mem: 16, arch: PresetArch.ARM });
        expect(await shape!("c7i.xlarge")).toEqual({ cpu: 4, mem: 8, arch: PresetArch.X86 });
        expect(await shape!("c7gn.4xlarge")).toEqual({ cpu: 16, mem: 32, arch: PresetArch.ARM });
        expect(await shape!("r8g.large")).toEqual({ cpu: 2, mem: 16, arch: PresetArch.ARM });
        expect(await shape!("t4g.small")).toEqual({ cpu: 2, mem: 2, arch: PresetArch.ARM });
        expect(await shape!("t3.medium")).toEqual({ cpu: 2, mem: 4, arch: PresetArch.X86 });
        expect(await shape!("g4dn.xlarge")).toEqual({ cpu: 4, mem: 16, gpu: "t4", arch: PresetArch.X86 });
        expect(await shape!("g5g.xlarge")).toEqual({ cpu: 4, mem: 8, gpu: "t4", arch: PresetArch.ARM });
        expect(await shape!("p5.48xlarge")).toEqual({ cpu: 192, mem: 2048, gpu: "h100", arch: PresetArch.X86 });
    });

    it("gives null for a type it cannot read", async () => {
        expect(await shape!("m5.metal")).toBeNull();
        expect(await shape!("u-6tb1.112xlarge")).toBeNull();
        expect(await shape!("nonsense")).toBeNull();
    });

    it("gives the core a prior per place: arm and small are quieter, gpu is not", async () => {
        const { client } = fake({
            ...SUBNETS,
            DescribeAvailabilityZones: () => {
                return {};
            },
            DescribeInstanceTypeOfferings: (input) => {
                return {
                    InstanceTypeOfferings: (input.Filters as { Values: string[] }[])[0]!.Values.map((type) => {
                        return { InstanceType: type, Location: "us-east-1a" };
                    }),
                };
            },
            DescribeInstances: () => {
                return { Reservations: [] };
            },
        });

        const cloud = createAws({ region: "us-east-1", extra: { client } });
        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [cloud],
            kinds: [
                {
                    name: "w",
                    try: [
                        { provider: "aws", market: [Market.SPOT], types: ["c8g.xlarge", "c7i.8xlarge", "g6.xlarge"] },
                    ],
                },
            ],
            store: mkdtempSync(join(tmpdir(), "rig-aws-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(
            (await rig.place.list("w")).map((place) => {
                return [place.type, place.risk.prior];
            }),
        ).toEqual([
            ["c8g.xlarge", 6.4],
            ["c7i.8xlarge", 12],
            ["g6.xlarge", 25],
        ]);
    });

    it("reads a medium size as one vCPU", async () => {
        expect(await shape!("m6g.medium")).toEqual({ cpu: 1, mem: 4, arch: PresetArch.ARM });
    });

    it("gives null for a burstable size, or a class, the data file does not hold", async () => {
        expect(await shape!("t3.huge")).toBeNull();
        expect(await shape!("q1.large")).toBeNull();
    });
});
