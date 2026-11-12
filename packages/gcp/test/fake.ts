import { Distro, Market } from "@diphyx/rig";

import { createGcp } from "../src/index.js";

/** A fake route's answer to a call, by its body and path. */
export type Handler = (body: Record<string, unknown> | undefined, path: string) => unknown;

/** A fake Compute Engine: routes by `METHOD path`, a regex; every call is kept. */
export function fake(routes: Record<string, Handler>) {
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];

    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
        const key = `${method} ${path.split("?")[0]}`;

        calls.push({ method, path, body: body as Record<string, unknown> });

        for (const [pattern, handler] of Object.entries(routes)) {
            if (new RegExp(`^${pattern}$`).test(key)) {
                return handler(body as Record<string, unknown>, path);
            }
        }

        throw new Error(`fake gce: no route ${key}`);
    };

    return { request, calls };
}

/** A finished operation. */
export const DONE = (): unknown => {
    return { status: "DONE" };
};

/** The region's two zones. */
export const REGION = {
    "GET projects/p/regions/us-central1": () => {
        return { zones: ["https://x/zones/us-central1-a", "https://x/zones/us-central1-b"] };
    },
};

/** The machine's own firewall rules: made, listed, deleted. */
export const FIREWALLS: Record<string, Handler> = {
    "POST projects/p/global/firewalls": DONE,
    "GET projects/p/global/firewalls": () => {
        return { items: [] };
    },
    "DELETE projects/p/global/firewalls/.*": DONE,
    /* Each family's newest image: the family's name and a date. */
    "GET projects/[^/]+/global/images/family/.*": (_body, path) => {
        const [, project, , , , family] = path.split("/");

        return {
            name: `${family}-v20260101`,
            selfLink: `https://compute.googleapis.com/compute/v1/projects/${project}/global/images/${family}-v20260101`,
        };
    },
};

/** A gcp provider on the fake, its routes over the firewall ones, with every call it made. */
export function gcp(routes: Record<string, Handler>) {
    const { request, calls } = fake({ ...routes, ...FIREWALLS, ...routes });

    return { provider: createGcp({ region: "us-central1", extra: { project: "p", request } }), calls };
}

/** A demand arm place in the region's first zone. */
export const PLACE = { market: Market.DEMAND, type: "c4a-standard-8", zone: "us-central1-a" } as const;

/** A worker machine's spec, with its rig tags. */
export const SPEC = {
    name: "app-w-0a1b2c3d",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-0a1b2c3d" },
    ports: [],
    distro: { name: Distro.UBUNTU, version: "24.04" },
};
