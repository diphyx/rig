/* The clouds under test: their providers, made from the local packages, and the types the stages use on each. */
import type { Presets, Provider } from "@diphyx/rig";
import { AuthFrom as AwsAuthFrom, createAws } from "@diphyx/rig-aws";
import { AuthFrom as AzureAuthFrom, createAzure } from "@diphyx/rig-azure";
import { AuthFrom as GcpAuthFrom, createGcp } from "@diphyx/rig-gcp";

import { fail } from "./log.ts";

/** The app name; it tags every machine the tests make. */
export const APP = process.env.RIG_E2E_APP ?? "rig-e2e";

/** The clouds to test: `RIG_E2E=aws,gcp,azure`; aws and gcp by default. */
export const CLOUDS = (process.env.RIG_E2E ?? "aws,gcp").split(",").filter(Boolean);

/** Per cloud: a type it does not sell, a small type, and a small type for spot. */
export const TYPES: Record<string, { none: string; small: string; spot: string }> = {
    aws: { none: "x9z.nothing", small: "t3.micro", spot: "t3.small" },
    gcp: { none: "x9-nothing-1", small: "e2-small", spot: "e2-medium" },
    azure: { none: "Standard_X9_nothing", small: "Standard_B2s", spot: "Standard_D2as_v5" },
};

/** Per cloud: the port its stage's grid hub listens on, for its nodes' heartbeats; the host lets them all in. */
export const LISTEN: Record<string, number> = { aws: 9421, gcp: 9422, azure: 9423 };

/** The tags of every machine the tests make, as the core gives them to a provider's `list`. */
export const TAGS = { rig: "1", "rig-app": APP };

/** The tags of one kind's machines: a stage's own, while the others run. */
export function tagsOf(kind: string): Record<string, string> {
    return { ...TAGS, "rig-kind": kind };
}

/* Each cloud's provider: keys by `RIG_<NAME>_<KEY>` when set (spec §8.1), else its SDK's own sign-in; the region by `RIG_<NAME>_REGION` (spec §8.2). */
const MAKERS: Record<string, () => Provider> = {
    aws: () => {
        return createAws(process.env.RIG_AWS_ID ? { auth: { from: AwsAuthFrom.ENV } } : {});
    },
    gcp: () => {
        return createGcp(process.env.RIG_GCP_KEY ? { auth: { from: GcpAuthFrom.ENV } } : {});
    },
    azure: () => {
        return createAzure(process.env.RIG_AZURE_ID ? { auth: { from: AzureAuthFrom.ENV } } : {});
    },
};

let providers: Provider[] | null = null;

/** A cloud's provider, made new, with its presets. */
export function makeProvider(cloud: string): Provider & { presets: Presets } {
    const make = MAKERS[cloud];

    if (!make || !TYPES[cloud]) {
        fail(`RIG_E2E: ${cloud} is a cloud the tests take: ${Object.keys(MAKERS).join(", ")}`);
    }

    return make() as Provider & { presets: Presets };
}

/** The providers of `CLOUDS`, made once. */
export function providersOf(): Provider[] {
    providers ??= CLOUDS.map(makeProvider);

    if (providers.length === 0) {
        fail(`RIG_E2E: at least one cloud: ${Object.keys(MAKERS).join(", ")}`);
    }

    return providers;
}

/** A provider by its name, with its presets. */
export function providerOf(name: string): Provider & { presets: Presets } {
    const found = providersOf().find((provider) => {
        return provider.name === name;
    });

    if (!found) {
        fail(`${name}: a cloud RIG_E2E names`);
    }

    return found as Provider & { presets: Presets };
}
