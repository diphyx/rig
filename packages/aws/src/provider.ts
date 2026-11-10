import {
    DescribeAvailabilityZonesCommand,
    DescribeInstancesCommand,
    DescribeInstanceTypeOfferingsCommand,
    type Instance,
    RebootInstancesCommand,
    RunInstancesCommand,
    type RunInstancesCommandInput,
    StartInstancesCommand,
    StopInstancesCommand,
    TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import {
    type Answer,
    createPresets,
    Market,
    Reason,
    Slot,
    type Entry,
    type Place,
    type Presets,
    type Provider,
    type ProviderMachine,
    type Shape,
    Refusal,
    type Spec,
    type Tags,
} from "@diphyx/rig";

import { KEYS, resolveAuth } from "./auth.js";
import { type AwsConfig, checkConfig } from "./config.js";
import { busyOf, PRESETS, RIG, toAws } from "./data.js";
import { createDisk } from "./disk.js";
import { codeOf, createEc2 } from "./ec2.js";
import { LIVE, toMachine } from "./machine.js";
import { createPorts } from "./ports.js";
import { shapeOf } from "./shape.js";

export type Aws = Provider & { keys: string[]; presets: Presets };

/* Ubuntu 24.04, by Canonical's public SSM parameter. */
const UBUNTU = {
    arm64: "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id",
    x86_64: "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
};

function awsTags(tags: Tags): { Key: string; Value: string }[] {
    return Object.entries(toAws(tags)).map(([Key, Value]) => {
        return { Key, Value };
    });
}

/** The aws provider: EC2, `spot` and `demand`, in one region. */
export function createAws(config: AwsConfig): Aws {
    checkConfig(config);

    const name = config.name ?? "aws";
    const extra = config.extra ?? {};
    const ec2 = createEc2(config.region, extra, resolveAuth(name, config.auth));
    const ports = createPorts(ec2);

    /* §11: one try. `spec.extra` goes first, so the one try and the tags always win. */
    async function input(place: Place, spec: Spec): Promise<RunInstancesCommandInput> {
        const image = spec.image ?? UBUNTU[await ec2.arch(place.type)];
        const tags = awsTags({ Name: spec.name, ...spec.tags });

        return {
            ...(spec.extra as Partial<RunInstancesCommandInput> | undefined),
            ImageId: image,
            InstanceType: place.type as never,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: (await ec2.subnets()).get(place.zone),
            MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
            TagSpecifications: [
                { ResourceType: "instance", Tags: tags },
                { ResourceType: "volume", Tags: tags },
            ],
            ...(spec.script !== undefined && { UserData: Buffer.from(spec.script).toString("base64") }),
            ...(spec.disk !== undefined && {
                BlockDeviceMappings: [
                    {
                        DeviceName: await ec2.root(image),
                        Ebs: { VolumeSize: spec.disk, VolumeType: "gp3", DeleteOnTermination: true },
                    },
                ],
            }),
            ...(place.market === Market.SPOT && {
                InstanceMarketOptions: {
                    MarketType: "spot",
                    SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
                },
            }),
            ...(config.identity && { IamInstanceProfile: { Name: config.identity } }),
            ...(extra.key && { KeyName: extra.key }),
        };
    }

    return {
        slot: Slot.PROVIDER,
        name,
        rig: RIG,
        can: { spot: true, stop: true, disk: true, port: true },
        keys: KEYS,
        presets: createPresets(name, PRESETS),

        /** §11: the keys and the region work. */
        async check(): Promise<void> {
            await ec2.send(new DescribeAvailabilityZonesCommand({}));
        },

        /** §11: from the type's name and the data file. */
        async shape(type: string): Promise<Shape | null> {
            return shapeOf(type);
        },

        /** §11: the entry's types, in every zone that sells them and has a subnet, once per market. */
        async places(entry: Entry): Promise<Place[]> {
            const zones = await ec2.subnets();

            const answer = await ec2.send<{ InstanceTypeOfferings?: { InstanceType?: string; Location?: string }[] }>(
                new DescribeInstanceTypeOfferingsCommand({
                    LocationType: "availability-zone",
                    Filters: [{ Name: "instance-type", Values: entry.types }],
                }),
            );

            return (answer.InstanceTypeOfferings ?? [])
                .filter((offer) => {
                    return zones.has(offer.Location ?? "");
                })
                .flatMap((offer) => {
                    return entry.market.map((market) => {
                        return { market, type: offer.InstanceType!, zone: offer.Location! };
                    });
                });
        },

        /** §11: exactly one try; no room is `busy`, by the data file; anything else throws. */
        async create(place: Place, spec: Spec): Promise<Answer> {
            try {
                const answer = await ec2.send<{ Instances?: Instance[] }>(
                    new RunInstancesCommand(await input(place, spec)),
                );

                return { ok: { id: answer.Instances![0]!.InstanceId! } };
            } catch (error) {
                const busy = busyOf(codeOf(error));

                if (busy) {
                    return { busy, message: (error as Error).message };
                }

                throw error;
            }
        },

        /** §11: an unknown id is `null`. */
        async get(id: string): Promise<ProviderMachine | null> {
            const instance = await ec2.instance(id);

            return instance ? toMachine(instance) : null;
        },

        /** §11: every machine with all the tags, in every status but `ended`, every page. */
        async list(tags: Tags): Promise<ProviderMachine[]> {
            const machines: ProviderMachine[] = [];

            const filters = [
                ...Object.entries(toAws(tags)).map(([key, value]) => {
                    return { Name: `tag:${key}`, Values: [value] };
                }),
                { Name: "instance-state-name", Values: LIVE },
            ];

            let token: string | undefined;

            do {
                const answer = await ec2.send<{ Reservations?: { Instances?: Instance[] }[]; NextToken?: string }>(
                    new DescribeInstancesCommand({ Filters: filters, ...(token && { NextToken: token }) }),
                );

                for (const reservation of answer.Reservations ?? []) {
                    for (const instance of reservation.Instances ?? []) {
                        machines.push(toMachine(instance));
                    }
                }

                token = answer.NextToken;
            } while (token);

            return machines;
        },

        /** §11: its port rules go first, then the machine; an ended one still loses what it left. The root disk goes with it. */
        async end(id: string): Promise<void> {
            const instance = await ec2.instance(id);

            await ports.release(id);

            if (instance && instance.State?.Name !== "terminated") {
                await ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }));
            }

            await ports.sweep();
        },

        async reboot(id: string): Promise<void> {
            await ec2.send(new RebootInstancesCommand({ InstanceIds: [id] }));
        },

        async start(id: string): Promise<void> {
            await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
        },

        /** §11: a `spot` machine cannot stop. */
        async stop(id: string): Promise<void> {
            const instance = await ec2.instance(id);

            if (instance?.InstanceLifecycle === "spot") {
                throw new Refusal(Reason.UNSUPPORTED, `${id} is spot: it cannot stop`);
            }

            await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
        },

        disk: createDisk(ec2),

        port: {
            open: ports.open,
            close: ports.close,
            list: ports.list,
        },
    };
}
