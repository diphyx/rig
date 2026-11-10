import type { EC2Client } from "@aws-sdk/client-ec2";
import { Reason, Refusal } from "@diphyx/rig";
import { isString } from "radash";

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
    /** An EC2 key pair for every machine. */
    key?: string;
    /** For tests: anything with the EC2 client's `send`. */
    client?: Pick<EC2Client, "send">;
};

const CONFIG = ["region", "name", "auth", "identity", "extra"];
const EXTRA = ["subnets", "key", "client"];

/** §8.2: a key outside the table is a refusal; aws's own go in `extra`, and aws checks those too. */
export function checkConfig(config: AwsConfig): void {
    const unknown = (keys: string[], known: string[], at: string): void => {
        for (const key of keys) {
            if (!known.includes(key)) {
                throw new Refusal(
                    Reason.CONFIG,
                    `aws: unknown key ${at}${key}${at === "" ? "; aws's own go in extra" : ""}`,
                );
            }
        }
    };

    unknown(Object.keys(config), CONFIG, "");
    unknown(Object.keys(config.extra ?? {}), EXTRA, "extra.");

    if (!isString(config.region) || config.region === "") {
        throw new Refusal(Reason.CONFIG, "aws: region is required");
    }
}
