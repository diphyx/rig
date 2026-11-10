import {
    AuthorizeSecurityGroupIngressCommand,
    CreateSecurityGroupCommand,
    DeleteSecurityGroupCommand,
    DescribeSecurityGroupRulesCommand,
    DescribeSecurityGroupsCommand,
    ModifyInstanceAttributeCommand,
    RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";

import { Proto, type Rule } from "@diphyx/rig";

import type { Ec2 } from "./ec2.js";

/* The tag on the security group rig makes for one machine: its instance id. */
const GROUP = "rig-machine";

type Answer = {
    SecurityGroupRules?: {
        SecurityGroupRuleId?: string;
        IsEgress?: boolean;
        IpProtocol?: string;
        FromPort?: number;
        ToPort?: number;
        CidrIpv4?: string;
    }[];
};

/** A machine's ports: a security group of its own, made on the first `open`. */
export function createPorts(ec2: Ec2) {
    async function find(id: string): Promise<string | null> {
        const found = await ec2.send<{ SecurityGroups?: { GroupId?: string }[] }>(
            new DescribeSecurityGroupsCommand({ Filters: [{ Name: `tag:${GROUP}`, Values: [id] }] }),
        );

        return found.SecurityGroups?.[0]?.GroupId ?? null;
    }

    /* The machine's groups, without or with its own. */
    async function attach(id: string, group: string, on: boolean): Promise<void> {
        const instance = await ec2.instance(id);
        const groups = (instance?.SecurityGroups ?? [])
            .map((one) => {
                return one.GroupId!;
            })
            .filter((one) => {
                return one !== group;
            });

        await ec2.send(
            new ModifyInstanceAttributeCommand({ InstanceId: id, Groups: on ? [...groups, group] : groups }),
        );
    }

    async function make(id: string): Promise<string> {
        const instance = await ec2.instance(id);
        const made = await ec2.send<{ GroupId?: string }>(
            new CreateSecurityGroupCommand({
                GroupName: `rig-${id}`,
                Description: `rig: the ports of ${id}`,
                VpcId: instance?.VpcId,
                TagSpecifications: [{ ResourceType: "security-group", Tags: [{ Key: GROUP, Value: id }] }],
            }),
        );

        await attach(id, made.GroupId!, true);

        return made.GroupId!;
    }

    return {
        async open(id: string, rule: Rule): Promise<Rule> {
            const group = (await find(id)) ?? (await make(id));
            const answer = await ec2.send<Answer>(
                new AuthorizeSecurityGroupIngressCommand({
                    GroupId: group,
                    IpPermissions: [
                        {
                            IpProtocol: rule.proto ?? Proto.TCP,
                            FromPort: rule.port,
                            ToPort: rule.to ?? rule.port,
                            IpRanges: [{ CidrIp: rule.from }],
                        },
                    ],
                }),
            );

            return { ...rule, id: answer.SecurityGroupRules?.[0]?.SecurityGroupRuleId ?? "" };
        },

        async close(id: string, rule: string): Promise<void> {
            const group = await find(id);

            if (group) {
                await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: group, SecurityGroupRuleIds: [rule] }));
            }
        },

        async list(id: string): Promise<Rule[]> {
            const group = await find(id);

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
                        from: one.CidrIpv4 ?? "",
                    };
                });
        },

        /** §11: before `end`: off the machine, then deleted, so no rule outlives it. */
        async release(id: string): Promise<void> {
            const group = await find(id);

            if (!group) {
                return;
            }

            await attach(id, group, false);
            await ec2.send(new DeleteSecurityGroupCommand({ GroupId: group }));
        },
    };
}
