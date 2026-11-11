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
    Arch,
    Busy,
    createPresets,
    regionOf,
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
    Status,
    type Tags,
} from "@diphyx/rig";

import { sleep, tryit } from "radash";

import { KEYS, resolveAuth } from "./auth.js";
import { type AwsConfig, checkConfig } from "./config.js";
import { busyOf, DISTROS, PRESETS, REGION, RIG, toAws } from "./data.js";
import { createDisk } from "./disk.js";
import { codeOf, createEc2 } from "./ec2.js";
import { LIVE, toMachine } from "./machine.js";
import { createPorts } from "./ports.js";
import { shapeOf } from "./shape.js";

export type Aws = Provider & { keys: string[]; presets: Presets };

/* EC2's answer to an image it cannot find in the region: an AMI it does not have, or an SSM parameter it cannot read. */
function missing(error: unknown): boolean {
    const code = codeOf(error);

    return (
        code === "InvalidAMIID.NotFound" ||
        code === "InvalidAMIID.Unavailable" ||
        (code === "InvalidParameterValue" && /ssm/i.test((error as Error).message ?? ""))
    );
}

/* How long EC2 may answer a new instance's id as not found, as its calls catch up: it is `pending` till then. */
const NEW = 5 * 60_000;

/* How long `end` waits for a machine to terminate, so its group can go: up to 5 minutes. */
const TERMINATING = { every: 5000, tries: 60 };

function awsTags(tags: Tags): { Key: string; Value: string }[] {
    return Object.entries(toAws(tags)).map(([Key, Value]) => {
        return { Key, Value };
    });
}

/** The aws provider: EC2, `spot` and `demand`, in one region. */
export function createAws(config: AwsConfig = {}): Aws {
    checkConfig(config);

    const name = config.name ?? "aws";
    const extra = config.extra ?? {};
    const region = regionOf(config.region, REGION.env, REGION.default, name);
    const ec2 = createEc2(region, extra, resolveAuth(name, config.auth));
    const ports = createPorts(ec2);

    /* The instances this provider made, as `RunInstances` gave them, and when. */
    const made = new Map<string, { instance: Instance; at: number }>();

    /* Terminated, and waited for: its group is held until then; one held longer is left for a sweep. */
    async function terminate(id: string): Promise<void> {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }));

        for (let tries = 0; tries < TERMINATING.tries; tries += 1) {
            const instance = await ec2.instance(id);

            if (!instance || instance.State?.Name === "terminated") {
                return;
            }

            await sleep(TERMINATING.every);
        }
    }

    /* An instance as rig sees it: running in a subnet that gives public IPs, it is `pending` until it has its own. */
    async function machineOf(instance: Instance): Promise<ProviderMachine> {
        const machine = toMachine(instance);

        if (machine.status !== Status.RUNNING || instance.PublicIpAddress || !instance.SubnetId) {
            return machine;
        }

        const [, subnets] = await tryit(ec2.subnets)();
        const subnet = [...(subnets?.values() ?? [])].find((one) => {
            return one.subnet === instance.SubnetId;
        });

        return subnet?.public ? { ...machine, status: Status.PENDING } : machine;
    }

    /* §11: the image to boot: the entry's as it is, or the newest image of the kind's distro for the type's arch. */
    async function imageOf(place: Place, spec: Spec): Promise<{ image: string; root: string }> {
        if (spec.image !== undefined) {
            return { image: spec.image, root: await ec2.root(spec.image) };
        }

        const arch = await ec2.arch(place.type);
        const pointer = DISTROS.pointerOf(spec.distro!, arch === "arm64" ? Arch.ARM : Arch.X86);

        return { image: `resolve:ssm:${pointer.ssm}`, root: pointer.root };
    }

    /* §11: one try. `spec.extra` goes first, so the one try and the tags always win. */
    async function input(place: Place, spec: Spec, subnet: string, group: string): Promise<RunInstancesCommandInput> {
        const { image, root } = await imageOf(place, spec);
        const tags = awsTags({ Name: spec.name, ...spec.tags });

        return {
            ...(spec.extra as Partial<RunInstancesCommandInput> | undefined),
            ImageId: image,
            InstanceType: place.type as never,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: subnet,
            SecurityGroupIds: [group],
            MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
            TagSpecifications: [
                { ResourceType: "instance", Tags: tags },
                { ResourceType: "volume", Tags: tags },
            ],
            ...(spec.script !== undefined && { UserData: Buffer.from(spec.script).toString("base64") }),
            /* §11: the root disk always goes with the machine, whatever the image says; the entry's other disks stay. */
            BlockDeviceMappings: [
                ...((spec.extra as Partial<RunInstancesCommandInput> | undefined)?.BlockDeviceMappings ?? []).filter(
                    (mapping) => {
                        return mapping.DeviceName !== root;
                    },
                ),
                {
                    DeviceName: root,
                    Ebs: {
                        VolumeType: "gp3",
                        DeleteOnTermination: true,
                        ...(spec.disk !== undefined && { VolumeSize: spec.disk }),
                    },
                },
            ],
            ...(place.market === Market.SPOT && {
                InstanceMarketOptions: {
                    MarketType: "spot",
                    SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
                },
            }),
            ...(config.identity && { IamInstanceProfile: { Name: config.identity } }),
        };
    }

    return {
        slot: Slot.PROVIDER,
        name,
        rig: RIG,
        can: { spot: true, stop: true, disk: true, port: true },
        distros: DISTROS.offers,
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

        /** §11: the entry's types, in every zone that sells them and has a subnet, once per market, every page. */
        async places(entry: Entry): Promise<Place[]> {
            const zones = await ec2.subnets();

            const offers: { InstanceType?: string; Location?: string }[] = [];
            let token: string | undefined;

            do {
                const answer = await ec2.send<{
                    InstanceTypeOfferings?: { InstanceType?: string; Location?: string }[];
                    NextToken?: string;
                }>(
                    new DescribeInstanceTypeOfferingsCommand({
                        LocationType: "availability-zone",
                        Filters: [{ Name: "instance-type", Values: entry.types }],
                        ...(token && { NextToken: token }),
                    }),
                );

                offers.push(...(answer.InstanceTypeOfferings ?? []));
                token = answer.NextToken;
            } while (token);

            return offers
                .filter((offer) => {
                    return zones.has(offer.Location ?? "");
                })
                .flatMap((offer) => {
                    return entry.market.map((market) => {
                        return { market, type: offer.InstanceType!, zone: offer.Location! };
                    });
                });
        },

        /** §11: exactly one try, behind a security group of its own made first; no room is `busy`, by the data file; anything else throws. */
        async create(place: Place, spec: Spec): Promise<Answer> {
            const { subnet, vpc } = (await ec2.subnets()).get(place.zone)!;
            const group = await ports.make(spec.name, vpc, spec.ports);

            try {
                const answer = await ec2.send<{ Instances?: Instance[] }>(
                    new RunInstancesCommand(await input(place, spec, subnet, group)),
                );

                const instance = answer.Instances![0]!;
                const id = instance.InstanceId!;

                made.set(id, { instance, at: Date.now() });

                /* So `end` finds the group even once the machine is gone. */
                await tryit(ports.own)(group, id);

                return { ok: { id } };
            } catch (error) {
                /* §11: a failed try leaves nothing it made; a group that will not go is left for a sweep. */
                await tryit(ports.remove)(group);

                /* §11: a region without the distro's image has no room for the type. */
                if (spec.distro && missing(error)) {
                    return { busy: Busy.TYPE, message: (error as Error).message };
                }

                const busy = busyOf(codeOf(error));

                if (busy) {
                    return { busy, message: (error as Error).message };
                }

                throw error;
            }
        },

        /** §11: an unknown id is `null`; one it made a moment ago, that EC2 has yet to find, is `pending`. */
        async get(id: string): Promise<ProviderMachine | null> {
            const instance = await ec2.instance(id);

            if (instance) {
                return await machineOf(instance);
            }

            const fresh = made.get(id);

            return fresh && Date.now() - fresh.at < NEW ? toMachine(fresh.instance) : null;
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
                        machines.push(await machineOf(instance));
                    }
                }

                token = answer.NextToken;
            } while (token);

            return machines;
        },

        /** §11: the machine, waited for, then its group; groups of machines gone earlier go too. The root disk goes with it. */
        async end(id: string): Promise<void> {
            const instance = await ec2.instance(id);
            const group = await ports.groupOf(id);

            made.delete(id);

            if (instance && instance.State?.Name !== "terminated") {
                await terminate(id);
            }

            if (group) {
                await ports.remove(group);
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
