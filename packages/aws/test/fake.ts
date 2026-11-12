import { Distro, Market } from "@diphyx/rig";

/** A fake command's answer, made from its input. */
export type Handler = (input: Record<string, unknown>) => unknown;

/** A fake EC2 client: each command by its class name, answered by a handler; every call is kept. */
export function fake(handlers: Record<string, Handler>) {
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

/** Throws an error whose name is this one, as an AWS error. */
export function fail(name: string): never {
    throw Object.assign(new Error(name), { name });
}

/** Two subnets in one VPC, in us-east-1a and us-east-1b. */
export const SUBNETS = {
    DescribeSubnets: () => {
        return {
            Subnets: [
                { SubnetId: "subnet-a", AvailabilityZone: "us-east-1a", VpcId: "vpc-1" },
                { SubnetId: "subnet-b", AvailabilityZone: "us-east-1b", VpcId: "vpc-1" },
            ],
        };
    },
};

/** The machine's own security group, made before it. */
export const GROUP = {
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

/** An instance type that runs arm64. */
export const ARM = {
    DescribeInstanceTypes: () => {
        return { InstanceTypes: [{ ProcessorInfo: { SupportedArchitectures: ["arm64"] } }] };
    },
};

/** A RunInstances handler that keeps each input and answers instance i-1. */
export function run(input: Record<string, unknown>[] = []): Handler {
    return (sent) => {
        input.push(sent);

        return { Instances: [{ InstanceId: "i-1" }] };
    };
}

/** A demand c8g.xlarge in us-east-1a. */
export const PLACE = { market: Market.DEMAND, type: "c8g.xlarge", zone: "us-east-1a" } as const;

/** A worker machine's spec on Ubuntu 24.04. */
export const SPEC = {
    name: "app-w-00000000",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-00000000" },
    ports: [],
    distro: { name: Distro.UBUNTU, version: "24.04" },
};

/** The commands sent, by name, in order. */
export function commandsOf(sent: { command: string }[]): string[] {
    return sent.map((one) => {
        return one.command;
    });
}

/** The input of the first command sent with this name. */
export function inputOf(
    sent: { command: string; input: Record<string, unknown> }[],
    command: string,
): Record<string, unknown> {
    return sent.find((one) => {
        return one.command === command;
    })!.input;
}

/** One instance, as DescribeInstances answers it. */
export function reservation(instance: Record<string, unknown>) {
    return { Reservations: [{ Instances: [instance] }] };
}
