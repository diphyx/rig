import { afterEach, describe, expect, it, vi } from "vitest";

import { createAws } from "../src/index.js";
import { fake, fail, SUBNETS, GROUP, ARM, run, PLACE, SPEC, commandsOf, inputOf, reservation } from "./fake.js";

describe("aws: machines", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const INSTANCE = {
        InstanceId: "i-1",
        State: { Name: "running" },
        RootDeviceName: "/dev/sda1",
        BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-1" } }],
        Tags: [{ Key: "rig-name", Value: "app-w-1" }],
        SecurityGroups: [{ GroupId: "sg-own", GroupName: "app-w-1" }],
    };

    it("starts, reboots, grows the root disk and reads it back; closes a rule by its id", async () => {
        const { client, sent } = fake({
            DescribeInstances: () => {
                return { Reservations: [{ Instances: [INSTANCE] }] };
            },
            StartInstances: () => {
                return {};
            },
            RebootInstances: () => {
                return {};
            },
            ModifyVolume: () => {
                return {};
            },
            DescribeVolumes: () => {
                return { Volumes: [{ Size: 30 }] };
            },
            DescribeVolumesModifications: () => {
                return { VolumesModifications: [{ ModificationState: "modifying", TargetSize: 60 }] };
            },
            RevokeSecurityGroupIngress: () => {
                return {};
            },
        });

        const aws = createAws({ region: "us-east-1", extra: { client } });

        await aws.start!("i-1");
        await aws.reboot("i-1");
        await aws.disk!.grow("i-1", 60);

        expect(await aws.disk!.get("i-1")).toEqual({ gb: 60, ready: false });

        await aws.port!.close("i-1", "sgr-1");

        const input = (command: string): Record<string, unknown> => {
            return sent.find((one) => {
                return one.command === command;
            })!.input;
        };

        expect(input("StartInstances")).toEqual({ InstanceIds: ["i-1"] });
        expect(input("RebootInstances")).toEqual({ InstanceIds: ["i-1"] });
        expect(input("ModifyVolume")).toEqual({ VolumeId: "vol-1", Size: 60 });
        expect(input("RevokeSecurityGroupIngress")).toEqual({ GroupId: "sg-own", SecurityGroupRuleIds: ["sgr-1"] });
    });

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

    it("is pending while running with no public IP yet, in a subnet that gives one", async () => {
        const ip: Record<string, string> = {};
        const { client } = fake({
            DescribeSubnets: () => {
                return {
                    Subnets: [
                        {
                            SubnetId: "subnet-a",
                            AvailabilityZone: "us-east-1a",
                            VpcId: "vpc-1",
                            MapPublicIpOnLaunch: true,
                        },
                        { SubnetId: "subnet-b", AvailabilityZone: "us-east-1b", VpcId: "vpc-1" },
                    ],
                };
            },
            DescribeInstances: (input) => {
                const id = (input.InstanceIds as string[])[0]!;

                return {
                    Reservations: [
                        {
                            Instances: [
                                {
                                    InstanceId: id,
                                    State: { Name: "running" },
                                    SubnetId: id === "i-private" ? "subnet-b" : "subnet-a",
                                    PrivateIpAddress: "10.0.0.1",
                                    ...(ip[id] && { PublicIpAddress: ip[id] }),
                                },
                            ],
                        },
                    ],
                };
            },
        });

        const provider = createAws({ region: "us-east-1", extra: { client } });

        expect((await provider.get("i-1"))!.status).toBe("pending");

        ip["i-1"] = "3.0.0.1";

        expect(await provider.get("i-1")).toMatchObject({
            status: "running",
            ip: { public: "3.0.0.1", private: "10.0.0.1" },
        });

        expect((await provider.get("i-private"))!.status).toBe("running");
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
                                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                                    SecurityGroups: [{ GroupId: "sg-own", GroupName: "app-w-1" }],
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

    it("maps a bare instance onto a pending demand machine, with its image and only a public IP", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return reservation({
                    InstanceId: "i-1",
                    State: { Name: "rebooting" },
                    ImageId: "ami-1",
                    PublicIpAddress: "3.0.0.1",
                    Tags: [{ Key: "rig" }, { Value: "lost" }],
                });
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).get("i-1")).toEqual({
            id: "i-1",
            status: "pending",
            market: "demand",
            type: "",
            zone: "",
            image: "ami-1",
            tags: { rig: "", "": "lost" },
            ip: { public: "3.0.0.1" },
            created: 0,
        });
    });

    it("maps an instance with no state onto pending", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return reservation({ InstanceId: "i-1" });
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).get("i-1")).toMatchObject({
            status: "pending",
        });
    });

    it("keeps a running machine running when its subnets cannot be found", async () => {
        const { client } = fake({
            DescribeSubnets: () => {
                return fail("UnauthorizedOperation");
            },
            DescribeInstances: () => {
                return reservation({ InstanceId: "i-1", State: { Name: "running" }, SubnetId: "subnet-a" });
            },
        });

        expect((await createAws({ region: "us-east-1", extra: { client } }).get("i-1"))!.status).toBe("running");
    });

    it("throws an error EC2 gives for an instance that is not a not found", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return fail("UnauthorizedOperation");
            },
        });

        await expect(createAws({ region: "us-east-1", extra: { client } }).get("i-1")).rejects.toThrow(
            "UnauthorizedOperation",
        );
    });

    it("throws an error EC2 gives with no code", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                throw Object.assign(new Error("no code"), { name: undefined });
            },
        });

        await expect(createAws({ region: "us-east-1", extra: { client } }).get("i-1")).rejects.toThrow("no code");
    });

    it("answers null for a machine it made once EC2 has had 5 minutes to find it", async () => {
        vi.useFakeTimers({ now: 0 });

        const { client } = fake({
            ...SUBNETS,
            ...GROUP,
            ...ARM,
            RunInstances: run(),
            DescribeInstances: () => {
                return { Reservations: [{}] };
            },
        });

        const aws = createAws({ region: "us-east-1", extra: { client } });

        await aws.create(PLACE, SPEC);

        expect(await aws.get("i-1")).toMatchObject({ status: "pending" });

        vi.setSystemTime(5 * 60_000);

        expect(await aws.get("i-1")).toBeNull();
    });

    it("lists nothing from reservations with no instances, or none at all", async () => {
        const { client } = fake({
            DescribeInstances: (input) => {
                return input.NextToken ? {} : { Reservations: [{}], NextToken: "t" };
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).list({})).toEqual([]);
    });

    it("stops a demand machine", async () => {
        const { client, sent } = fake({
            DescribeInstances: () => {
                return reservation({ InstanceId: "i-1", InstanceLifecycle: "scheduled" });
            },
            StopInstances: () => {
                return {};
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).stop!("i-1");

        expect(inputOf(sent, "StopInstances")).toEqual({ InstanceIds: ["i-1"] });
    });

    const SWEPT = {
        DescribeSecurityGroups: () => {
            return {};
        },
        DeleteSecurityGroup: () => {
            return {};
        },
    };

    it("checks every 5 seconds until the machine is terminated", async () => {
        vi.useFakeTimers();

        let reads = 0;
        const { client, sent } = fake({
            ...SWEPT,
            DescribeInstances: () => {
                reads += 1;

                return reservation({
                    InstanceId: "i-1",
                    State: { Name: reads < 4 ? "shutting-down" : "terminated" },
                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                    SecurityGroups: [{ GroupId: "sg-own", GroupName: "app-w-1" }],
                });
            },
            TerminateInstances: () => {
                return {};
            },
        });

        const ended = createAws({ region: "us-east-1", extra: { client } }).end("i-1");

        await vi.advanceTimersByTimeAsync(10_000);
        await ended;

        expect(reads).toBe(4);
        expect(inputOf(sent, "DeleteSecurityGroup")).toEqual({ GroupId: "sg-own" });
    });

    it("waits up to 5 minutes for a machine that holds on, and leaves its group to a sweep", async () => {
        vi.useFakeTimers();

        const { client, sent } = fake({
            ...SWEPT,
            DescribeInstances: () => {
                return reservation({
                    InstanceId: "i-1",
                    State: { Name: "shutting-down" },
                    Tags: [{ Key: "rig-name", Value: "app-w-1" }],
                    SecurityGroups: [{ GroupId: "sg-own", GroupName: "app-w-1" }],
                });
            },
            TerminateInstances: () => {
                return {};
            },
            DeleteSecurityGroup: () => {
                return fail("DependencyViolation");
            },
        });

        const ended = createAws({ region: "us-east-1", extra: { client } }).end("i-1");

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await ended;

        expect(
            commandsOf(sent).filter((command) => {
                return command === "DescribeInstances";
            }),
        ).toHaveLength(62);

        expect(commandsOf(sent)).toContain("DeleteSecurityGroup");
    });

    it("ends a machine terminated already with no terminate, and its group by its tag", async () => {
        const { client, sent } = fake({
            ...SWEPT,
            DescribeInstances: () => {
                return reservation({ InstanceId: "i-1", State: { Name: "terminated" } });
            },
            DescribeSecurityGroups: (input) => {
                return (input.Filters as { Name: string }[])[0]!.Name === "tag:rig-instance"
                    ? { SecurityGroups: [{ GroupId: "sg-tagged" }] }
                    : {};
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).end("i-1");

        expect(commandsOf(sent)).not.toContain("TerminateInstances");
        expect(inputOf(sent, "DeleteSecurityGroup")).toEqual({ GroupId: "sg-tagged" });
    });

    it("throws when a group will not go for a reason that is not a machine holding it", async () => {
        const { client } = fake({
            ...SWEPT,
            DescribeInstances: () => {
                return fail("InvalidInstanceID.NotFound");
            },
            DescribeSecurityGroups: () => {
                return { SecurityGroups: [{ GroupId: "sg-tagged" }] };
            },
            DeleteSecurityGroup: () => {
                return fail("UnauthorizedOperation");
            },
        });

        await expect(createAws({ region: "us-east-1", extra: { client } }).end("i-1")).rejects.toThrow(
            "UnauthorizedOperation",
        );
    });

    it("sweeps every page, an untimed group as old, and a group gone already as swept", async () => {
        const { client, sent } = fake({
            DescribeInstances: () => {
                return fail("InvalidInstanceID.NotFound");
            },
            DescribeSecurityGroups: (input) => {
                if ((input.Filters as { Name: string }[])[0]!.Name === "tag:rig-instance") {
                    return {};
                }

                return input.NextToken
                    ? { SecurityGroups: [{ GroupId: "sg-gone", Tags: [{ Key: "rig-machine", Value: "b" }] }] }
                    : {
                          SecurityGroups: [{ GroupId: "sg-untimed", Tags: [{ Key: "rig-machine", Value: "a" }] }],
                          NextToken: "page-2",
                      };
            },
            DeleteSecurityGroup: (input) => {
                return input.GroupId === "sg-gone" ? fail("InvalidGroup.NotFound") : {};
            },
        });

        await createAws({ region: "us-east-1", extra: { client } }).end("i-1");

        expect(
            sent
                .filter((one) => {
                    return one.command === "DescribeSecurityGroups";
                })
                .at(-1)!.input,
        ).toMatchObject({ NextToken: "page-2" });

        expect(
            sent
                .filter((one) => {
                    return one.command === "DeleteSecurityGroup";
                })
                .map((one) => {
                    return one.input.GroupId;
                }),
        ).toEqual(["sg-untimed", "sg-gone"]);
    });
});
