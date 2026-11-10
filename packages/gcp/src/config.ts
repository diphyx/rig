import { Reason, Refusal } from "@diphyx/rig";
import { isString } from "radash";

import type { Auth } from "./auth.js";
import type { Request } from "./gce.js";

/** Spec §8.2: the factory's config, the same keys on every rig provider; gcp's own under `extra`. */
export type GcpConfig = {
    /** A Compute Engine region: `us-central1`. */
    region: string;
    /** Its name in the config; `"gcp"`. Two regions are two providers, with two names. */
    name?: string;
    /** §8.1: how it signs in; `{ from: "auto" }`, Google's own sign-in. */
    auth?: Auth;
    /** What its machines run as: a service account's email. */
    identity?: string;
    extra?: GcpExtra;
};

/** The gcp provider's own settings, under `extra` (spec §8.2). */
export type GcpExtra = {
    /** The project; absent, the key's, or the one Google's sign-in gives. */
    project?: string;
    /** The VPC network: `global/networks/default`. */
    network?: string;
    /** A subnet of it, in the region: `regions/us-central1/subnetworks/main`. */
    subnet?: string;
    /** For tests: the Compute Engine REST calls, answered. */
    request?: Request;
};

const CONFIG = ["region", "name", "auth", "identity", "extra"];
const EXTRA = ["project", "network", "subnet", "request"];

/** §8.2: a key outside the table is a refusal; gcp's own go in `extra`, and gcp checks those too. */
export function checkConfig(config: GcpConfig): void {
    const unknown = (keys: string[], known: string[], at: string): void => {
        for (const key of keys) {
            if (!known.includes(key)) {
                throw new Refusal(
                    Reason.CONFIG,
                    `gcp: unknown key ${at}${key}${at === "" ? "; gcp's own go in extra" : ""}`,
                );
            }
        }
    };

    unknown(Object.keys(config), CONFIG, "");
    unknown(Object.keys(config.extra ?? {}), EXTRA, "extra.");

    if (!isString(config.region) || config.region === "") {
        throw new Refusal(Reason.CONFIG, "gcp: region is required");
    }
}
