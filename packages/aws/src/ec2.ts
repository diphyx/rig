import {
    DescribeImagesCommand,
    DescribeInstancesCommand,
    DescribeInstanceTypesCommand,
    DescribeSubnetsCommand,
    EC2Client,
    type Instance,
} from "@aws-sdk/client-ec2";

import type { Keys } from "./auth.js";
import type { AwsExtra } from "./config.js";
import { ssmRootOf } from "./data.js";

export type Arch = "arm64" | "x86_64";

/** A zone's subnet, and the VPC it is in. */
/** A subnet rig places machines in; `public` when it gives each machine a public IP. */
export type Subnet = { subnet: string; vpc: string; public: boolean };

/** An AWS error's code. */
export function codeOf(error: unknown): string {
    return (error as { name?: string }).name ?? "";
}

/** EC2, with the lookups the provider makes more than once, each cached. */
export function createEc2(region: string, extra: AwsExtra, keys: Keys | null) {
    const credentials = keys && {
        accessKeyId: keys.id,
        secretAccessKey: keys.secret,
        ...(keys.token && { sessionToken: keys.token }),
    };

    const client = extra.client ?? new EC2Client({ region, ...(credentials && { credentials }) });

    const send = client.send.bind(client) as <T>(command: unknown) => Promise<T>;
    const arches = new Map<string, Arch>();
    const roots = new Map<string, string>();

    let subnets: Promise<Map<string, Subnet>> | null = null;

    return {
        send,

        /** zone → its subnet and VPC: the given subnets, or the default VPC's; found once. */
        subnets(): Promise<Map<string, Subnet>> {
            subnets ??= send<{
                Subnets?: {
                    SubnetId?: string;
                    AvailabilityZone?: string;
                    VpcId?: string;
                    MapPublicIpOnLaunch?: boolean;
                }[];
            }>(
                new DescribeSubnetsCommand(
                    extra.subnets
                        ? { SubnetIds: extra.subnets }
                        : { Filters: [{ Name: "default-for-az", Values: ["true"] }] },
                ),
            ).then((answer) => {
                return new Map(
                    (answer.Subnets ?? []).map((subnet) => {
                        return [
                            subnet.AvailabilityZone!,
                            {
                                subnet: subnet.SubnetId!,
                                vpc: subnet.VpcId!,
                                public: subnet.MapPublicIpOnLaunch === true,
                            },
                        ];
                    }),
                );
            });

            subnets.catch(() => {
                subnets = null;
            });

            return subnets;
        },

        /** A type's CPU architecture. */
        async arch(type: string): Promise<Arch> {
            if (!arches.has(type)) {
                const answer = await send<{
                    InstanceTypes?: { ProcessorInfo?: { SupportedArchitectures?: string[] } }[];
                }>(new DescribeInstanceTypesCommand({ InstanceTypes: [type as never] }));

                const supported = answer.InstanceTypes?.[0]?.ProcessorInfo?.SupportedArchitectures ?? [];

                arches.set(type, supported.includes("arm64") ? "arm64" : "x86_64");
            }

            return arches.get(type)!;
        },

        /** An image's root device, so a disk size lands on it; an SSM parameter's, from the data file. */
        async root(image: string): Promise<string> {
            if (image.startsWith("resolve:ssm:")) {
                return ssmRootOf(image);
            }

            if (!roots.has(image)) {
                const answer = await send<{ Images?: { RootDeviceName?: string }[] }>(
                    new DescribeImagesCommand({ ImageIds: [image] }),
                );

                roots.set(image, answer.Images?.[0]?.RootDeviceName ?? "/dev/sda1");
            }

            return roots.get(image)!;
        },

        /** One instance, or `null` when EC2 does not know it. */
        async instance(id: string): Promise<Instance | null> {
            try {
                const answer = await send<{ Reservations?: { Instances?: Instance[] }[] }>(
                    new DescribeInstancesCommand({ InstanceIds: [id] }),
                );

                return answer.Reservations?.[0]?.Instances?.[0] ?? null;
            } catch (error) {
                if (codeOf(error) === "InvalidInstanceID.NotFound") {
                    return null;
                }

                throw error;
            }
        },
    };
}

export type Ec2 = ReturnType<typeof createEc2>;
