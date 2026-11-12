import { Market } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { createAws } from "../src/index.js";
import { fake, fail, SUBNETS, commandsOf, inputOf } from "./fake.js";

describe("aws: places", () => {
    it("gives the entry's types in zones with a subnet, once per market, every page", async () => {
        const { client } = fake({
            ...SUBNETS,
            DescribeInstanceTypeOfferings: (input) => {
                return input.NextToken
                    ? { InstanceTypeOfferings: [{ InstanceType: "c8g.xlarge", Location: "us-east-1b" }] }
                    : {
                          InstanceTypeOfferings: [
                              { InstanceType: "c8g.xlarge", Location: "us-east-1a" },
                              { InstanceType: "c8g.xlarge", Location: "us-east-1c" },
                          ],
                          NextToken: "page-2",
                      };
            },
        });

        const places = await createAws({ region: "us-east-1", extra: { client } }).places({
            provider: "aws",
            market: [Market.SPOT, Market.DEMAND],
            types: ["c8g.xlarge"],
        });

        expect(places).toEqual([
            { market: "spot", type: "c8g.xlarge", zone: "us-east-1a" },
            { market: "demand", type: "c8g.xlarge", zone: "us-east-1a" },
            { market: "spot", type: "c8g.xlarge", zone: "us-east-1b" },
            { market: "demand", type: "c8g.xlarge", zone: "us-east-1b" },
        ]);
    });

    const ENTRY = { provider: "aws", market: [Market.DEMAND], types: ["c8g.xlarge"] };

    it("asks for the given subnets by id, and for the default VPC's otherwise", async () => {
        const offers = {
            DescribeInstanceTypeOfferings: () => {
                return { InstanceTypeOfferings: [{ InstanceType: "c8g.xlarge", Location: "us-east-1a" }] };
            },
        };

        const given = fake({ ...SUBNETS, ...offers });

        await createAws({ region: "us-east-1", extra: { subnets: ["subnet-a"], client: given.client } }).places(ENTRY);

        expect(inputOf(given.sent, "DescribeSubnets")).toEqual({ SubnetIds: ["subnet-a"] });

        const found = fake({ ...SUBNETS, ...offers });

        await createAws({ region: "us-east-1", extra: { client: found.client } }).places(ENTRY);

        expect(inputOf(found.sent, "DescribeSubnets")).toEqual({
            Filters: [{ Name: "default-for-az", Values: ["true"] }],
        });
    });

    it("finds the subnets once, and asks again after a failed try", async () => {
        let tries = 0;
        const { client, sent } = fake({
            DescribeSubnets: () => {
                tries += 1;

                return tries === 1 ? fail("RequestLimitExceeded") : SUBNETS.DescribeSubnets();
            },
            DescribeInstanceTypeOfferings: () => {
                return { InstanceTypeOfferings: [{ InstanceType: "c8g.xlarge", Location: "us-east-1a" }] };
            },
        });

        const aws = createAws({ region: "us-east-1", extra: { client } });

        await expect(aws.places(ENTRY)).rejects.toThrow("RequestLimitExceeded");
        expect(await aws.places(ENTRY)).toEqual([{ market: "demand", type: "c8g.xlarge", zone: "us-east-1a" }]);
        expect(await aws.places(ENTRY)).toHaveLength(1);

        expect(
            commandsOf(sent).filter((command) => {
                return command === "DescribeSubnets";
            }),
        ).toHaveLength(2);
    });

    it("gives no places when the region has no subnets or no offers", async () => {
        const { client } = fake({
            DescribeSubnets: () => {
                return {};
            },
            DescribeInstanceTypeOfferings: () => {
                return {};
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).places(ENTRY)).toEqual([]);
    });

    it("leaves out an offer with no zone", async () => {
        const { client } = fake({
            ...SUBNETS,
            DescribeInstanceTypeOfferings: () => {
                return { InstanceTypeOfferings: [{ InstanceType: "c8g.xlarge" }] };
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).places(ENTRY)).toEqual([]);
    });
});
