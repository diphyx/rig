import { Market, Distro } from "@diphyx/rig";
import { afterEach, beforeEach, vi } from "vitest";

import { createAzure } from "../src/index.js";

/** An answer of the fake Azure Resource Manager: its status, body and headers. */
export type Answer = { status: number; body: unknown; headers: Record<string, string> };

/** A route of the fake Azure Resource Manager: the call's body and path to its answer. */
export type Handler = (body: Record<string, unknown> | undefined, path: string) => Answer;

/** A 200 answer with the given body. */
export function ok(body: unknown = {}): Answer {
    return { status: 200, body, headers: {} };
}

/** An Azure error answer: its status, its code, and an inner detail code when given. */
export function failed(status: number, code: string, inner?: string): Answer {
    return {
        status,
        body: { error: { code, message: code, ...(inner && { details: [{ code: inner, message: inner }] }) } },
        headers: {},
    };
}

/** A fake Azure Resource Manager: routes by `METHOD path`, a regex on the path without its query; every call is kept. */
export function fake(routes: Record<string, Handler>) {
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];

    const request = async (method: string, path: string, body?: unknown): Promise<Answer> => {
        const key = `${method} ${path.split("?")[0]}`;

        calls.push({ method, path, body: body as Record<string, unknown> });

        for (const [pattern, handler] of Object.entries(routes)) {
            if (new RegExp(`^${pattern}$`).test(key)) {
                return handler(body as Record<string, unknown>, path);
            }
        }

        throw new Error(`fake arm: no route ${key}`);
    };

    return { request, calls };
}

/** The rig resource group of subscription `s`. */
export const RG = "/subscriptions/s/resourceGroups/rig";

/** The virtual machines of the rig resource group. */
export const VM = `${RG}/providers/Microsoft.Compute/virtualMachines`;

/** The network security groups of the rig resource group. */
export const NSG = `${RG}/providers/Microsoft.Network/networkSecurityGroups`;

/** The Marketplace image publishers of eastus. */
export const IMAGES = "/subscriptions/s/providers/Microsoft.Compute/locations/eastus/publishers";

/** The routes of the resource group, its network, the subscription, its locations and the image versions. */
export const NETWORK = {
    "PUT /subscriptions/s/resourcegroups/rig": () => {
        return ok();
    },
    [`PUT ${NSG}/.*-nsg`]: () => {
        return ok();
    },
    [`DELETE ${NSG}/.*-nsg`]: () => {
        return ok();
    },
    [`PUT ${RG}/providers/Microsoft.Network/virtualNetworks/rig-eastus`]: () => {
        return ok();
    },
    "GET /subscriptions/s": () => {
        return ok({ subscriptionId: "s" });
    },
    "GET /subscriptions/s/locations": () => {
        return ok({ value: [{ name: "eastus" }, { name: "westeurope" }] });
    },
    /* Every Marketplace image has two versions. */
    [`GET ${IMAGES}/.*/versions`]: () => {
        return ok([{ name: "1.9.0" }, { name: "1.10.0" }]);
    },
};

/** An eastus provider on subscription `s` over the fake Azure Resource Manager of the given routes, and its calls. */
export function azure(routes: Record<string, Handler>, extra: Record<string, unknown> = {}) {
    const { request, calls } = fake(routes);

    return { provider: createAzure({ region: "eastus", extra: { subscription: "s", request, ...extra } }), calls };
}

/** An on-demand place in eastus-1. */
export const PLACE = { market: Market.DEMAND, type: "Standard_D4ps_v6", zone: "eastus-1" } as const;

/** A worker's machine spec on Ubuntu 24.04. */
export const SPEC = {
    name: "app-w-0a1b2c3d",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-0a1b2c3d" },
    ports: [],
    distro: { name: Distro.UBUNTU, version: "24.04" },
};

/** Clears the Azure env vars before each test and undoes its mocks, stubbed globals and fake timers after it. */
export function cleanEach(): void {
    beforeEach(() => {
        delete process.env.AZURE_SUBSCRIPTION_ID;
        delete process.env.RIG_AZURE_SUBSCRIPTION;
        delete process.env.RIG_AZURE_EU_SUBSCRIPTION;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
}
