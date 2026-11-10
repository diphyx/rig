import type { EC2Client } from "@aws-sdk/client-ec2";
import { checkFactory } from "@diphyx/rig";

import type { Auth } from "./auth.js";

/** Spec §8.2: the factory's config, the same keys on every rig provider; aws's own under `extra`. */
export type AwsConfig = {
    region: string;
    /** Its name in the config; `"aws"`. Two regions are two providers, with two names. */
    name?: string;
    /** §8.1: how it signs in; `{ from: "auto" }`, the AWS SDK's own chain. */
    auth?: Auth;
    /** What its machines run as: an IAM instance profile's name. */
    identity?: string;
    extra?: AwsExtra;
};

/** The aws provider's own settings, under `extra` (spec §8.2). */
export type AwsExtra = {
    /** One subnet per zone; absent, the default VPC's default subnets. */
    subnets?: string[];
    /** For tests: anything with the EC2 client's `send`. */
    client?: Pick<EC2Client, "send">;
};

const EXTRA = ["subnets", "client"];

/** §8.2: the standard keys and aws's own `extra` keys; `region` is required. */
export function checkConfig(config: AwsConfig): void {
    checkFactory("aws", config, EXTRA);
}
