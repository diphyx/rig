import { Market, Distro } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { createAws } from "../src/index.js";
import { fake, fail, SUBNETS, GROUP, ARM, run, PLACE, SPEC, commandsOf } from "./fake.js";

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

    it("answers a machine it just made, that EC2 has yet to find, as pending; any other unknown id as null", async () => {
        const { client } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            RunInstances: run(),
            DescribeInstances: () => {
                return fail("InvalidInstanceID.NotFound");
            },
        });

        const aws = createAws({ region: "us-east-1", extra: { client } });

        await aws.create(PLACE, SPEC);

        expect(await aws.get("i-1")).toMatchObject({ id: "i-1", status: "pending" });
        expect(await aws.get("i-other")).toBeNull();
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

    it("always deletes the root disk with the machine, and tags its group with its id", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client, sent } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            RunInstances: run(inputs),
            CreateTags: () => {
                return {};
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, SPEC);

        expect(inputs[0]).toMatchObject({
            BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { DeleteOnTermination: true } }],
        });

        expect(
            sent.find((one) => {
                return one.command === "CreateTags";
            })!.input,
        ).toEqual({ Resources: ["sg-rig"], Tags: [{ Key: "rig-instance", Value: "i-1" }] });
    });

    it("answers busy type when the region has no image of the distro", async () => {
        const { client } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            RunInstances: () => {
                return fail("InvalidAMIID.NotFound");
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, SPEC)).toMatchObject({
            busy: "type",
        });
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
            GroupName: SPEC.name,
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

    it("boots the x86 image for a type that is not arm, asking its arch once", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client, sent } = fake({
            ...SUBNETS,
            ...GROUP,
            DescribeInstanceTypes: () => {
                return {};
            },
            RunInstances: run(inputs),
        });

        const aws = createAws({ region: "us-east-1", extra: { client } });
        const place = { ...PLACE, type: "c7i.xlarge" };

        await aws.create(place, SPEC);
        await aws.create(place, SPEC);

        expect(inputs[0]).toMatchObject({ ImageId: expect.stringContaining("/amd64/") });

        expect(
            commandsOf(sent).filter((command) => {
                return command === "DescribeInstanceTypes";
            }),
        ).toHaveLength(1);
    });

    it("puts the disk on an image's own root device, asked once, /dev/sda1 when EC2 gives none", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client, sent } = fake({
            ...SUBNETS,
            ...GROUP,
            DescribeImages: (input) => {
                return (input.ImageIds as string[])[0] === "ami-xvda"
                    ? { Images: [{ RootDeviceName: "/dev/xvda" }] }
                    : {};
            },
            RunInstances: run(inputs),
        });

        const aws = createAws({ region: "us-east-1", extra: { client } });
        const { distro: _, ...spec } = SPEC;

        await aws.create(PLACE, { ...spec, image: "ami-xvda" });
        await aws.create(PLACE, { ...spec, image: "ami-xvda" });
        await aws.create(PLACE, { ...spec, image: "ami-other" });

        expect(inputs[0]).toMatchObject({ ImageId: "ami-xvda", BlockDeviceMappings: [{ DeviceName: "/dev/xvda" }] });
        expect(inputs[2]).toMatchObject({ ImageId: "ami-other", BlockDeviceMappings: [{ DeviceName: "/dev/sda1" }] });

        expect(
            commandsOf(sent).filter((command) => {
                return command === "DescribeImages";
            }),
        ).toHaveLength(2);
    });

    it("gives an SSM parameter the data file does not name the root device /dev/sda1, with no call", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client, sent } = fake({ ...SUBNETS, ...GROUP, RunInstances: run(inputs) });
        const { distro: _, ...spec } = SPEC;

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...spec,
            image: "resolve:ssm:/my/own/image",
        });

        expect(inputs[0]).toMatchObject({ BlockDeviceMappings: [{ DeviceName: "/dev/sda1" }] });
        expect(commandsOf(sent)).not.toContain("DescribeImages");
    });

    it("keeps the entry's other disks, and puts its own root disk in place of the entry's", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });

        await createAws({ region: "us-east-1", extra: { client } }).create(PLACE, {
            ...SPEC,
            extra: {
                BlockDeviceMappings: [
                    { DeviceName: "/dev/sda1", Ebs: { VolumeSize: 8, DeleteOnTermination: false } },
                    { DeviceName: "/dev/sdf", Ebs: { VolumeSize: 100 } },
                ],
            },
        });

        expect(inputs[0]!.BlockDeviceMappings).toEqual([
            { DeviceName: "/dev/sdf", Ebs: { VolumeSize: 100 } },
            { DeviceName: "/dev/sda1", Ebs: { VolumeType: "gp3", DeleteOnTermination: true } },
        ]);
    });

    it("answers busy type for an image EC2 cannot have or read, only for a distro's image", async () => {
        const answer = async (error: Error, image?: string) => {
            const { client } = fake({
                ...SUBNETS,
                ...GROUP,
                ...ARM,
                DescribeImages: () => {
                    return {};
                },
                RunInstances: () => {
                    throw error;
                },
            });

            const { distro, ...spec } = SPEC;

            return createAws({ region: "us-east-1", extra: { client } }).create(
                PLACE,
                image ? { ...spec, image } : { ...spec, distro },
            );
        };

        const coded = (name: string, message = name): Error => {
            return Object.assign(new Error(message), { name });
        };

        expect(await answer(coded("InvalidAMIID.Unavailable"))).toMatchObject({ busy: "type" });
        expect(await answer(coded("InvalidParameterValue", "no SSM parameter"))).toMatchObject({ busy: "type" });
        await expect(answer(coded("InvalidParameterValue", "bad size"))).rejects.toThrow("bad size");

        await expect(answer({ name: "InvalidParameterValue" } as Error)).rejects.toMatchObject({
            name: "InvalidParameterValue",
        });

        await expect(answer(coded("InvalidAMIID.NotFound"), "ami-1")).rejects.toThrow("InvalidAMIID.NotFound");
    });
});
