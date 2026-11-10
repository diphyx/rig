import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRig, Market, Distro, PresetArch, Refusal } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { resolveAuth } from "../src/auth.js";
import { AuthFrom, createAws } from "../src/index.js";

type Handler = (input: Record<string, unknown>) => unknown;

/* A fake EC2 client: each command by its class name, answered by a handler; every call is kept. */
function fake(handlers: Record<string, Handler>) {
    const sent: { command: string; input: Record<string, unknown> }[] = [];

    const client = {
        async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
            const name = command.constructor.name.replace(/Command$/, "");

            sent.push({ command: name, input: command.input });

            const handler = handlers[name];

            if (!handler) {
                throw new Error(`fake ec2: no ${name}`);
            }

            return handler(command.input);
        },
    };

    return { client: client as never, sent };
}

function fail(name: string): never {
    throw Object.assign(new Error(name), { name });
}

const SUBNETS = {
    DescribeSubnets: () => {
        return {
            Subnets: [
                { SubnetId: "subnet-a", AvailabilityZone: "us-east-1a", VpcId: "vpc-1" },
                { SubnetId: "subnet-b", AvailabilityZone: "us-east-1b", VpcId: "vpc-1" },
            ],
        };
    },
};

/* The machine's own security group, made before it. */
const GROUP = {
    CreateSecurityGroup: () => {
        return { GroupId: "sg-rig" };
    },
    AuthorizeSecurityGroupIngress: () => {
        return {};
    },
    DeleteSecurityGroup: () => {
        return {};
    },
};

const ARM = {
    DescribeInstanceTypes: () => {
        return { InstanceTypes: [{ ProcessorInfo: { SupportedArchitectures: ["arm64"] } }] };
    },
};

function run(input: Record<string, unknown>[] = []): Handler {
    return (sent) => {
        input.push(sent);

        return { Instances: [{ InstanceId: "i-1" }] };
    };
}

const PLACE = { market: Market.DEMAND, type: "c8g.xlarge", zone: "us-east-1a" } as const;

const SPEC = {
    name: "app-w-00000000",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-00000000" },
    ports: [],
    distro: { name: Distro.UBUNTU, version: "24.04" },
};

describe("aws: factory", () => {
    it("takes the standard config, aws's own under extra, and refuses any other key", () => {
        expect(createAws({ region: "us-east-1", extra: { client: fake({}).client } })).toMatchObject({
            name: "aws",
            rig: 1,
        });

        expect(createAws({ region: "eu-west-1", name: "aws-eu", extra: { client: fake({}).client } }).name).toBe(
            "aws-eu",
        );

        expect(() => {
            return createAws({ region: "us-east-1", subnets: ["subnet-a"] } as never);
        }).toThrow(/unknown key subnets; aws's own go in extra/);

        expect(() => {
            return createAws({ region: "us-east-1", extra: { subnet: ["subnet-a"] } } as never);
        }).toThrow(/unknown key extra.subnet/);

        expect(() => {
            return createAws({} as never);
        }).toThrow(/region is required/);
    });
});

describe("aws: auth", () => {
    it("is the SDK's own chain for auto, the default", () => {
        expect(resolveAuth("aws")).toBeNull();
        expect(resolveAuth("aws", { from: AuthFrom.AUTO })).toBeNull();
    });

    it("reads RIG_<NAME>_<KEY> from env, upper case, - as _", () => {
        expect(
            resolveAuth("aws-east", { from: AuthFrom.ENV }, { RIG_AWS_EAST_ID: "i", RIG_AWS_EAST_SECRET: "s" }),
        ).toEqual({
            id: "i",
            secret: "s",
        });

        expect(
            resolveAuth("aws", { from: AuthFrom.ENV, prefix: "MY" }, { MY_ID: "i", MY_SECRET: "s", MY_TOKEN: "t" }),
        ).toEqual({ id: "i", secret: "s", token: "t" });
    });

    it("takes keys passed in", () => {
        expect(resolveAuth("aws", { from: AuthFrom.KEYS, keys: { id: "i", secret: "s" } })).toEqual({
            id: "i",
            secret: "s",
        });
    });

    it("refuses at once a missing key or one aws does not take, never showing a value", () => {
        expect(() => {
            return createAws({ region: "us-east-1", auth: { from: AuthFrom.ENV, prefix: "NONE" } });
        }).toThrow(/missing id/);

        try {
            resolveAuth("aws", { from: AuthFrom.KEYS, keys: { id: "i", secret: "very-secret", pass: "p" } as never });
        } catch (error) {
            expect(error).toBeInstanceOf(Refusal);
            expect((error as Refusal).reason).toBe("plugin");
            expect((error as Refusal).message).toContain("pass");
            expect((error as Refusal).message).not.toContain("very-secret");
        }
    });

    it("names its keys, and runs machines as its identity", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });
        const cloud = createAws({ region: "us-east-1", identity: "rig-machines", extra: { client } });

        expect(cloud.keys).toEqual(["id", "secret", "token?"]);

        await cloud.create(PLACE, SPEC);

        expect(inputs[0]).toMatchObject({ IamInstanceProfile: { Name: "rig-machines" } });
    });
});

describe("aws: places", () => {
    it("gives the entry's types in zones with a subnet, once per market", async () => {
        const { client } = fake({
            ...SUBNETS,
            DescribeInstanceTypeOfferings: () => {
                return {
                    InstanceTypeOfferings: [
                        { InstanceType: "c8g.xlarge", Location: "us-east-1a" },
                        { InstanceType: "c8g.xlarge", Location: "us-east-1c" },
                    ],
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
        ]);
    });
});

describe("aws: create", () => {
    it("runs one demand machine in the zone's subnet, with the tags and the default image", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        const answer = await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, SPEC);

        expect(answer).toEqual({ ok: { id: "i-1" } });

        expect(inputs[0]).toMatchObject({
            ImageId: expect.stringContaining("/arm64/"),
            InstanceType: "c8g.xlarge",
            SubnetId: "subnet-a",
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [
                { ResourceType: "instance", Tags: expect.arrayContaining([{ Key: "rig-app", Value: "app" }]) },
                { ResourceType: "volume", Tags: expect.arrayContaining([{ Key: "rig", Value: "1" }]) },
            ],
        });

        expect(inputs[0]).not.toHaveProperty("InstanceMarketOptions");
    });

    it("boots a distro's newest image: by its public SSM parameter, its root device from the data file", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...SPEC,
            distro: { name: Distro.DEBIAN, version: "12" },
            disk: 40,
        });

        expect(inputs[0]).toMatchObject({
            ImageId: "resolve:ssm:/aws/service/debian/release/12/latest/arm64",
            BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 40 } }],
        });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...SPEC,
            image: "resolve:ssm:/aws/service/debian/release/12/latest/arm64",
            disk: 40,
        });

        expect(inputs[1]).toMatchObject({ BlockDeviceMappings: [{ DeviceName: "/dev/xvda" }] });
    });

    it("makes the machine's own group first, with only the kind's ports, and runs the machine in it", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client, sent } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...SPEC,
            ports: [{ port: 22, from: "1.2.3.4/32" }],
        });

        const commands = sent.map((one) => {
            return one.command;
        });

        expect(commands.indexOf("CreateSecurityGroup")).toBeLessThan(commands.indexOf("RunInstances"));

        expect(
            sent.find((one) => {
                return one.command === "CreateSecurityGroup";
            })!.input,
        ).toMatchObject({
            GroupName: `rig-${SPEC.name}`,
            VpcId: "vpc-1",
        });

        expect(
            sent.find((one) => {
                return one.command === "AuthorizeSecurityGroupIngress";
            })!.input,
        ).toMatchObject({
            GroupId: "sg-rig",
            IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.2.3.4/32" }] }],
        });

        expect(inputs[0]).toMatchObject({ SecurityGroupIds: ["sg-rig"] });
        expect(commands).not.toContain("DeleteSecurityGroup");
    });

    it("leaves nothing behind after a failed try: its group is deleted", async () => {
        const { client, sent } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            RunInstances: () => {
                return fail("InsufficientInstanceCapacity");
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, SPEC)).toMatchObject({
            busy: "zone",
        });

        expect(
            sent.find((one) => {
                return one.command === "DeleteSecurityGroup";
            })!.input,
        ).toEqual({ GroupId: "sg-rig" });
    });

    it("asks for a one-time spot machine that ends on a take-back", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        await createAws({ region: "us-east-1", extra: { client } }).create({ ...PLACE, market: Market.SPOT }, SPEC);

        expect(inputs[0]).toMatchObject({
            InstanceMarketOptions: {
                MarketType: "spot",
                SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
            },
        });
    });

    it("sizes the root disk, and sends the script as user data", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...SPEC,
            disk: 50,
            script: "echo hi",
        });

        expect(inputs[0]).toMatchObject({
            BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 50, VolumeType: "gp3" } }],
            UserData: Buffer.from("echo hi").toString("base64"),
        });
    });

    it("keeps the tags and the one try, whatever extra says", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...SPEC,
            extra: { MaxCount: 5, TagSpecifications: [], EbsOptimized: true },
        });

        expect(inputs[0]).toMatchObject({ MaxCount: 1, EbsOptimized: true });
        expect((inputs[0]!.TagSpecifications as unknown[]).length).toBe(2);

        expect(inputs[0]!.TagSpecifications).toContainEqual(
            expect.objectContaining({ Tags: expect.arrayContaining([{ Key: "Name", Value: SPEC.name }]) }),
        );
    });

    it("turns the data file's codes into busy answers, and throws the rest", async () => {
        const answer = async (code: string) => {
            const { client } = fake({
                ...SUBNETS,
                ...GROUP,
                ...ARM,
                RunInstances: () => {
                    return fail(code);
                },
            });

            return createAws({ region: "us-east-1", extra: { client } }).create(PLACE, SPEC);
        };

        expect(await answer("InsufficientInstanceCapacity")).toMatchObject({ busy: "zone" });
        expect(await answer("Unsupported")).toMatchObject({ busy: "zone" });
        expect(await answer("SpotMaxPriceTooLow")).toMatchObject({ busy: "market" });
        expect(await answer("VcpuLimitExceeded")).toMatchObject({ busy: "account" });
        await expect(answer("UnauthorizedOperation")).rejects.toThrow("UnauthorizedOperation");
    });
});

describe("aws: machines", () => {
    it("maps an instance onto a machine, and an unknown id onto null", async () => {
        const { client } = fake({
            DescribeInstances: (input) => {
                if ((input.InstanceIds as string[])[0] === "i-gone") {
                    return fail("InvalidInstanceID.NotFound");
                }

                return {
                    Reservations: [
                        {
                            Instances: [
                                {
                                    InstanceId: "i-1",
                                    State: { Name: "shutting-down" },
                                    InstanceLifecycle: "spot",
                                    InstanceType: "c8g.xlarge",
                                    Placement: { AvailabilityZone: "us-east-1a" },
                                    PrivateIpAddress: "10.0.0.1",
                                    Tags: [{ Key: "rig", Value: "1" }],
                                    LaunchTime: new Date(1000),
                                },
                            ],
                        },
                    ],
                };
            },
        });

        const provider = createAws({ region: "us-east-1", extra: { client } });

        expect(await provider.get("i-1")).toEqual({
            id: "i-1",
            status: "ending",
            market: "spot",
            type: "c8g.xlarge",
            zone: "us-east-1a",
            tags: { rig: "1" },
            ip: { private: "10.0.0.1" },
            created: 1000,
        });

        expect(await provider.get("i-gone")).toBeNull();
    });

    it("lists by every tag, every page, never terminated", async () => {
        const { client, sent } = fake({
            DescribeInstances: (input) => {
                return input.NextToken
                    ? { Reservations: [{ Instances: [{ InstanceId: "i-2", State: { Name: "running" } }] }] }
                    : {
                          Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "running" } }] }],
                          NextToken: "t",
                      };
            },
        });

        const machines = await createAws({ region: "us-east-1", extra: { client } }).list({
            rig: "1",
            "rig-app": "app",
        });

        expect(
            machines.map((machine) => {
                return machine.id;
            }),
        ).toEqual(["i-1", "i-2"]);

        expect(sent[0]!.input.Filters).toEqual(
            expect.arrayContaining([
                { Name: "tag:rig", Values: ["1"] },
                { Name: "tag:rig-app", Values: ["app"] },
                expect.objectContaining({
                    Name: "instance-state-name",
                    Values: expect.not.arrayContaining(["terminated"]),
                }),
            ]),
        );
    });

    it("ends a machine, waits for it, then its own group; a young group of another try is left, an old one swept", async () => {
        const old = String(Date.now() - 60 * 60_000);
        const young = String(Date.now());
        let state = "running";
        const { client, sent } = fake({
            DescribeInstances: () => {
                return {
                    Reservations: [
                        {
                            Instances: [
                                {
                                    InstanceId: "i-1",
                                    State: { Name: state },
                                    SecurityGroups: [{ GroupId: "sg-own", GroupName: "rig-app-w-1" }],
                                },
                            ],
                        },
                    ],
                };
            },
            TerminateInstances: () => {
                state = "terminated";

                return {};
            },
            DescribeSecurityGroups: () => {
                return {
                    SecurityGroups: [
                        {
                            GroupId: "sg-old",
                            Tags: [
                                { Key: "rig-machine", Value: "gone" },
                                { Key: "rig-made", Value: old },
                            ],
                        },
                        {
                            GroupId: "sg-young",
                            Tags: [
                                { Key: "rig-machine", Value: "trying" },
                                { Key: "rig-made", Value: young },
                            ],
                        },
                    ],
                };
            },
            DeleteSecurityGroup: () => {
                return {};
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).end("i-1");

        const commands = sent.map((one) => {
            return one.command;
        });

        expect(commands.indexOf("TerminateInstances")).toBeLessThan(commands.indexOf("DeleteSecurityGroup"));

        expect(
            sent
                .filter((one) => {
                    return one.command === "DeleteSecurityGroup";
                })
                .map((one) => {
                    return one.input.GroupId;
                }),
        ).toEqual(["sg-own", "sg-old"]);
    });

    it("ends a gone machine with no terminate", async () => {
        const { client, sent } = fake({
            DescribeInstances: () => {
                return fail("InvalidInstanceID.NotFound");
            },
            DescribeSecurityGroups: () => {
                return { SecurityGroups: [] };
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).end("i-gone");

        expect(
            sent.map((one) => {
                return one.command;
            }),
        ).not.toContain("TerminateInstances");
    });

    it("refuses to stop a spot machine", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return { Reservations: [{ Instances: [{ InstanceId: "i-1", InstanceLifecycle: "spot" }] }] };
            },
        });

        await expect(createAws({ region: "us-east-1", extra: { client } }).stop!("i-1")).rejects.toMatchObject({
            reason: "unsupported",
        });
    });
});

describe("aws: presets", () => {
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
});

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
            { id: "sgr-1", port: 22, proto: "tcp", from: "1.2.3.4/32" },
            { id: "sgr-2", port: 443, proto: "tcp", from: "::/0" },
        ]);
    });
});

describe("aws: shape", () => {
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
});

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
