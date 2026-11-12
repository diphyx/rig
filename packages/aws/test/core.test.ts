import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRig } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { createAws } from "../src/index.js";
import { fake, SUBNETS, GROUP, ARM, run } from "./fake.js";

describe("aws: with the core", () => {
    it("checks at open, and creates a machine from a preset", async () => {
        const { client, sent } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            DescribeAvailabilityZones: () => {
                return {};
            },
            DescribeInstanceTypeOfferings: () => {
                return { InstanceTypeOfferings: [{ InstanceType: "t4g.small", Location: "us-east-1a" }] };
            },
            DescribeInstances: () => {
                return { Reservations: [] };
            },
            RunInstances: run(),
        });

        const cloud = createAws({ region: "us-east-1", extra: { client } });
        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [cloud],
            kinds: [cloud.presets.small({ name: "dev" })],
            store: mkdtempSync(join(tmpdir(), "rig-aws-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(sent[0]!.command).toBe("DescribeAvailabilityZones");

        expect(await rig.machine.create("dev")).toMatchObject({
            id: "i-1",
            provider: "aws",
            kind: "dev",
            market: "demand",
        });
    });
});
