import {
    AuthorizeSecurityGroupIngressCommand,
    CreateSecurityGroupCommand,
    DeleteSecurityGroupCommand,
    DescribeSecurityGroupRulesCommand,
    DescribeSecurityGroupsCommand,
    type IpPermission,
    RevokeSecurityGroupIngressCommand,
    type Tag,
} from "@aws-sdk/client-ec2";

import { Proto, type Rule } from "@diphyx/rig";

import { codeOf, type Ec2 } from "./ec2.js";
import { tagsOf } from "./machine.js";

/* The tags on the security group rig makes for one machine: its rig name, and when it was made. */
const GROUP = "rig-machine";
const MADE = "rig-made";

/* The start of its name; the rest is the machine's rig name. */
const PREFIX = "rig-";

/* A group younger than this may be a try still running: `sweep` leaves it. */
const YOUNG = 10 * 60_000;

type Answer = {
    SecurityGroupRules?: {
        SecurityGroupRuleId?: string;
        IsEgress?: boolean;
        IpProtocol?: string;
        FromPort?: number;
        ToPort?: number;
        CidrIpv4?: string;
        CidrIpv6?: string;
    }[];
};

/** A rule, as EC2 takes it; an IPv6 source goes in its own field. */
function permissionOf(rule: Rule): IpPermission {
    return {
        IpProtocol: rule.proto ?? Proto.TCP,
        FromPort: rule.port,
        ToPort: rule.to ?? rule.port,
        ...(rule.from.includes(":")
            ? { Ipv6Ranges: [{ CidrIpv6: rule.from }] }
            : { IpRanges: [{ CidrIp: rule.from }] }),
    };
}

/** A machine's ports: a security group of its own, made before it, with nothing open but the kind's ports. */
export function createPorts(ec2: Ec2) {
    /* The machine's own group: the one it runs in, named `rig-<its rig name>`. */
    async function groupOf(id: string): Promise<string | null> {
        const instance = await ec2.instance(id);
        const own = instance?.SecurityGroups?.find((group) => {
            return group.GroupName?.startsWith(PREFIX);
        });

        return own?.GroupId ?? null;
    }

    async function mine(id: string): Promise<string> {
        const group = await groupOf(id);

        if (!group) {
            throw new Error(`aws: ${id} has no security group of its own`);
        }

        return group;
    }

    /* A group a machine still holds, while it terminates, is left for a later `sweep`. */
    async function remove(group: string): Promise<void> {
        await ec2.send(new DeleteSecurityGroupCommand({ GroupId: group })).catch((error: unknown) => {
            if (codeOf(error) !== "DependencyViolation" && codeOf(error) !== "InvalidGroup.NotFound") {
                throw error;
            }
        });
    }

    return {
        groupOf,
        remove,

        /** §11: the machine's own group, made before it: inbound closed but `rules`; a failed one leaves nothing. */
        async make(name: string, vpc: string, rules: Rule[]): Promise<string> {
            const made = await ec2.send<{ GroupId?: string }>(
                new CreateSecurityGroupCommand({
                    GroupName: `${PREFIX}${name}`,
                    Description: `rig: the ports of ${name}`,
                    VpcId: vpc,
                    TagSpecifications: [
                        {
                            ResourceType: "security-group",
                            Tags: [
                                { Key: GROUP, Value: name },
                                { Key: MADE, Value: String(Date.now()) },
                            ],
                        },
                    ],
                }),
            );

            try {
                if (rules.length > 0) {
                    await ec2.send(
                        new AuthorizeSecurityGroupIngressCommand({
                            GroupId: made.GroupId!,
                            IpPermissions: rules.map(permissionOf),
                        }),
                    );
                }
            } catch (error) {
                await remove(made.GroupId!);

                throw error;
            }

            return made.GroupId!;
        },

        async open(id: string, rule: Rule): Promise<Rule> {
            const answer = await ec2.send<Answer>(
                new AuthorizeSecurityGroupIngressCommand({
                    GroupId: await mine(id),
                    IpPermissions: [permissionOf(rule)],
                }),
            );

            return { ...rule, id: answer.SecurityGroupRules?.[0]?.SecurityGroupRuleId ?? "" };
        },

        async close(id: string, rule: string): Promise<void> {
            await ec2.send(
                new RevokeSecurityGroupIngressCommand({ GroupId: await mine(id), SecurityGroupRuleIds: [rule] }),
            );
        },

        async list(id: string): Promise<Rule[]> {
            const group = await groupOf(id);

            if (!group) {
                return [];
            }

            const answer = await ec2.send<Answer>(
                new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: "group-id", Values: [group] }] }),
            );

            return (answer.SecurityGroupRules ?? [])
                .filter((one) => {
                    return !one.IsEgress;
                })
                .map((one) => {
                    return {
                        id: one.SecurityGroupRuleId!,
                        port: one.FromPort ?? 0,
                        ...(one.ToPort !== one.FromPort && { to: one.ToPort ?? 0 }),
                        proto: one.IpProtocol === Proto.UDP ? Proto.UDP : Proto.TCP,
                        from: one.CidrIpv4 ?? one.CidrIpv6 ?? "",
                    };
                });
        },

        /** §11: rig's groups that nothing holds any more, but those young enough to be a try still running. */
        async sweep(): Promise<void> {
            const found = await ec2.send<{ SecurityGroups?: { GroupId?: string; Tags?: Tag[] }[] }>(
                new DescribeSecurityGroupsCommand({ Filters: [{ Name: "tag-key", Values: [GROUP] }] }),
            );

            for (const group of found.SecurityGroups ?? []) {
                if (Date.now() - Number(tagsOf(group.Tags)[MADE] ?? 0) >= YOUNG) {
                    await remove(group.GroupId!);
                }
            }
        },
    };
}
