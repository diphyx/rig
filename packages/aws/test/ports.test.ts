import { Protocol } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { createAws } from "../src/index.js";
import { fake, fail, SUBNETS, GROUP, ARM, run, PLACE, SPEC, commandsOf, inputOf, reservation } from "./fake.js";

describe("aws: ports", () => {
    it("opens IPv4 and IPv6 rules on the machine's own group, and lists both back", async () => {
        const opened: Record<string, unknown>[] = [];
        const { client } = fake({
            DescribeInstances: () => {
                return {
                    Reservations: [
                        {
                            Instances: [
                                {
                                    InstanceId: "i-1",
                                    /* A group as rig 1.0 named it. */
                                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                                    SecurityGroups: [{ GroupId: "sg-rig", GroupName: "rig-app-w-1" }],
                                },
                            ],
                        },
                    ],
                };
            },
            AuthorizeSecurityGroupIngress: (input) => {
                opened.push(input);

                return { SecurityGroupRules: [{ SecurityGroupRuleId: `sgr-${opened.length}` }] };
            },
            DescribeSecurityGroupRules: () => {
                return {
                    SecurityGroupRules: [
                        {
                            SecurityGroupRuleId: "sgr-1",
                            IpProtocol: "tcp",
                            FromPort: 22,
                            ToPort: 22,
                            CidrIpv4: "1.2.3.4/32",
                        },
                        {
                            SecurityGroupRuleId: "sgr-2",
                            IpProtocol: "tcp",
                            FromPort: 443,
                            ToPort: 443,
                            CidrIpv6: "::/0",
                        },
                        { SecurityGroupRuleId: "sgr-out", IsEgress: true, IpProtocol: "-1" },
                    ],
                };
            },
        });

        const { port } = createAws({ region: "us-east-1", extra: { client } });

        expect(await port!.open("i-1", { port: 22, from: "1.2.3.4/32" })).toMatchObject({ id: "sgr-1" });
        await port!.open("i-1", { port: 443, from: "::/0" });

        expect((opened[0]!.IpPermissions as object[])[0]).toMatchObject({ IpRanges: [{ CidrIp: "1.2.3.4/32" }] });
        expect((opened[1]!.IpPermissions as object[])[0]).toMatchObject({ Ipv6Ranges: [{ CidrIpv6: "::/0" }] });

        expect(await port!.list("i-1")).toEqual([
            { id: "sgr-1", port: 22, protocol: "tcp", from: "1.2.3.4/32" },
            { id: "sgr-2", port: 443, protocol: "tcp", from: "::/0" },
        ]);
    });

    it("opens a UDP range, as EC2 takes it, with no id when EC2 gives none", async () => {
        const { client, sent } = fake({
            DescribeInstances: () => {
                return reservation({
                    InstanceId: "i-1",
                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                    SecurityGroups: [
                        { GroupId: "sg-other", GroupName: "default" },
                        { GroupId: "sg-own", GroupName: "app-w-1" },
                    ],
                });
            },
            AuthorizeSecurityGroupIngress: () => {
                return {};
            },
        });

        const rule = { port: 60000, to: 61000, protocol: Protocol.UDP, from: "0.0.0.0/0" };

        expect(await createAws({ region: "us-east-1", extra: { client } }).port!.open("i-1", rule)).toEqual({
            ...rule,
            id: "",
        });

        expect(inputOf(sent, "AuthorizeSecurityGroupIngress")).toEqual({
            GroupId: "sg-own",
            IpPermissions: [{ IpProtocol: "udp", FromPort: 60000, ToPort: 61000, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
        });
    });

    it("lists a UDP range back, and a rule EC2 gives bare with 0 for each port and from nowhere", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return reservation({
                    InstanceId: "i-1",
                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                    SecurityGroups: [{ GroupId: "sg-own", GroupName: "app-w-1" }],
                });
            },
            DescribeSecurityGroupRules: (input) => {
                expect(input).toEqual({ Filters: [{ Name: "group-id", Values: ["sg-own"] }] });

                return {
                    SecurityGroupRules: [
                        {
                            SecurityGroupRuleId: "sgr-1",
                            IpProtocol: "udp",
                            FromPort: 60000,
                            ToPort: 61000,
                            CidrIpv4: "0.0.0.0/0",
                        },
                        { SecurityGroupRuleId: "sgr-2", IpProtocol: "-1", ToPort: 5 },
                        { SecurityGroupRuleId: "sgr-3", IpProtocol: "tcp", FromPort: 22 },
                    ],
                };
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).port!.list("i-1")).toEqual([
            { id: "sgr-1", port: 60000, to: 61000, protocol: "udp", from: "0.0.0.0/0" },
            { id: "sgr-2", port: 0, to: 5, protocol: "tcp", from: "" },
            { id: "sgr-3", port: 22, protocol: "tcp", from: "" },
        ]);
    });

    it("lists no rules from a group EC2 gives none for", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return reservation({
                    InstanceId: "i-1",
                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                    SecurityGroups: [{ GroupId: "sg-own", GroupName: "app-w-1" }],
                });
            },
            DescribeSecurityGroupRules: () => {
                return {};
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).port!.list("i-1")).toEqual([]);
    });

    it("finds the group of a machine with no rig name by its tag", async () => {
        const { client, sent } = fake({
            DescribeInstances: () => {
                return reservation({ InstanceId: "i-1", SecurityGroups: [{ GroupId: "sg-default" }] });
            },
            DescribeSecurityGroups: () => {
                return { SecurityGroups: [{ GroupId: "sg-tagged" }] };
            },
            RevokeSecurityGroupIngress: () => {
                return {};
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).port!.close("i-1", "sgr-1");

        expect(inputOf(sent, "DescribeSecurityGroups")).toEqual({
            Filters: [{ Name: "tag:rig-instance", Values: ["i-1"] }],
        });

        expect(inputOf(sent, "RevokeSecurityGroupIngress")).toEqual({
            GroupId: "sg-tagged",
            SecurityGroupRuleIds: ["sgr-1"],
        });
    });

    it("lists nothing for a machine with no group of its own, and refuses to open or close a rule on it", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return fail("InvalidInstanceID.NotFound");
            },
            DescribeSecurityGroups: () => {
                return {};
            },
        });

        const { port } = createAws({ region: "us-east-1", extra: { client } });

        expect(await port!.list("i-1")).toEqual([]);

        await expect(port!.open("i-1", { port: 22, from: "1.2.3.4/32" })).rejects.toThrow(
            "aws: i-1 has no security group of its own",
        );

        await expect(port!.close("i-1", "sgr-1")).rejects.toThrow("aws: i-1 has no security group of its own");
    });

    it("deletes its new group when the kind's ports cannot open, and throws, running nothing", async () => {
        const { client, sent } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            AuthorizeSecurityGroupIngress: () => {
                return fail("InvalidPermission.Malformed");
            },
            RunInstances: run(),
        });

        await expect(
            createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
                ...SPEC,
                ports: [{ port: 22, from: "1.2.3.4/32" }],
            }),
        ).rejects.toThrow("InvalidPermission.Malformed");

        expect(inputOf(sent, "DeleteSecurityGroup")).toEqual({ GroupId: "sg-rig" });
        expect(commandsOf(sent)).not.toContain("RunInstances");
    });
});
