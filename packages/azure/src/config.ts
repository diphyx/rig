import { checkFactory, Reason, Refusal } from "@diphyx/rig";

import type { Request } from "./arm.js";
import type { Auth } from "./auth.js";

/** Spec §8.2: the factory's config, the same keys on every rig provider; azure's own under `extra`. */
export type AzureConfig = {
    /** An Azure region: `eastus`. */
    region: string;
    /** Its name in the config; `"azure"`. Two regions are two providers, with two names. */
    name?: string;
    /** §8.1: how it signs in; `{ from: "auto" }`, Azure's own sign-in. */
    auth?: Auth;
    /** What its machines run as: a user-assigned managed identity's resource id. */
    identity?: string;
    extra?: AzureExtra;
};

/** The azure provider's own settings, under `extra` (spec §8.2). */
export type AzureExtra = {
    /** The subscription; absent, `AZURE_SUBSCRIPTION_ID`. */
    subscription?: string;
    /** The resource group its machines go in; `"rig"`, made on first use. */
    group?: string;
    /** A subnet's resource id; absent, a network of rig's own in the group, made on first use. */
    subnet?: string;
    /** An SSH public key for the machines' `rig` user; absent, a random password, kept nowhere. */
    key?: string;
    /** For tests: the Azure Resource Manager REST calls, answered. */
    request?: Request;
};

const EXTRA = ["subscription", "group", "subnet", "key", "request"];

/** §8.2: the standard keys and azure's own `extra` keys; `region` is required. */
export function checkConfig(config: AzureConfig): void {
    checkFactory("azure", config, EXTRA);
}

/** The subscription: `extra.subscription`, or `AZURE_SUBSCRIPTION_ID`; none is a refusal. */
export function subscriptionOf(config: AzureConfig): string {
    const subscription = config.extra?.subscription ?? process.env.AZURE_SUBSCRIPTION_ID;

    if (!subscription) {
        throw new Refusal(
            Reason.CONFIG,
            "azure: a subscription is required: extra.subscription, or AZURE_SUBSCRIPTION_ID",
        );
    }

    return subscription;
}
