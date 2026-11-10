import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRig, Market, PresetArch, Reason, Refusal } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { resolveAuth } from "../src/auth.js";
import { AuthFrom, createGcp, GceError } from "../src/index.js";

type Handler = (body: Record<string, unknown> | undefined, path: string) => unknown;

/* A fake Compute Engine: routes by `METHOD path`, a regex; every call is kept. */
function fake(routes: Record<string, Handler>) {
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

const DONE = (): unknown => {
    return { status: "DONE" };
};

const REGION = {
    "GET projects/p/regions/us-central1": () => {
        return { zones: ["https://x/zones/us-central1-a", "https://x/zones/us-central1-b"] };
    },
};

function gcp(routes: Record<string, Handler>) {
    const { request, calls } = fake(routes);

    return { provider: createGcp({ region: "us-central1", extra: { project: "p", request } }), calls };
}

const PLACE = { market: Market.DEMAND, type: "c4a-standard-8", zone: "us-central1-a" } as const;

const SPEC = {
    name: "app-w-0a1b2c3d",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-0a1b2c3d" },
};

describe("gcp: factory", () => {
    it("takes the standard config, gcp's own under extra, and refuses any other key", () => {
        expect(gcp({}).provider).toMatchObject({ name: "gcp", rig: 1, keys: ["key"] });

        expect(() => {
            return createGcp({ region: "us-central1", project: "p" } as never);
        }).toThrow(/unknown key project; gcp's own go in extra/);

        expect(() => {
            return createGcp({} as never);
        }).toThrow(/region is required/);
    });
});

describe("gcp: auth", () => {
    const KEY = JSON.stringify({ client_email: "a@p.iam.gserviceaccount.com", private_key: "pk", project_id: "p" });

    it("reads RIG_GCP_KEY from env, or a key passed in", () => {
        expect(resolveAuth("gcp", { from: AuthFrom.ENV }, { RIG_GCP_KEY: KEY })).toEqual({ key: KEY });
        expect(resolveAuth("gcp", { from: AuthFrom.KEYS, keys: { key: KEY } })).toEqual({ key: KEY });
        expect(resolveAuth("gcp")).toBeNull();
    });

    it("refuses a key that is not a service-account JSON, naming the key only", () => {
        try {
            createGcp({ region: "us-central1", auth: { from: AuthFrom.KEYS, keys: { key: "not-json-secret" } } });
            expect.unreachable();
        } catch (error) {
            expect((error as Refusal).reason).toBe(Reason.PLUGIN);
            expect((error as Refusal).message).not.toContain("not-json-secret");
        }
    });
});

describe("gcp: places", () => {
    it("gives the entry's types in the region's zones only, once per market", async () => {
        const { provider } = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return {
                    items: {
                        "zones/us-central1-a": { machineTypes: [{ name: "c4a-standard-8" }] },
                        "zones/europe-west1-b": { machineTypes: [{ name: "c4a-standard-8" }] },
                        "zones/us-central1-b": {},
                    },
                };
            },
        });

        expect(
            await provider.places({ provider: "gcp", market: [Market.SPOT, Market.DEMAND], types: ["c4a-standard-8"] }),
        ).toEqual([
            { market: Market.SPOT, type: "c4a-standard-8", zone: "us-central1-a" },
            { market: Market.DEMAND, type: "c4a-standard-8", zone: "us-central1-a" },
        ]);
    });
});

describe("gcp: create", () => {
    const inserted = (routes: Record<string, Handler> = {}) => {
        const bodies: Record<string, unknown>[] = [];
        const { provider } = gcp({
            "POST projects/p/zones/us-central1-a/instances": (body) => {
                bodies.push(body!);

                return { status: "DONE" };
            },
            ...routes,
        });

        return { provider, bodies };
    };

    it("inserts one demand machine, labelled, tagged by its name, on the arm image for an arm type", async () => {
        const { provider, bodies } = inserted();

        expect(await provider.create(PLACE, SPEC)).toEqual({ ok: { id: "us-central1-a/app-w-0a1b2c3d" } });

        expect(bodies[0]).toMatchObject({
            name: "app-w-0a1b2c3d",
            machineType: "zones/us-central1-a/machineTypes/c4a-standard-8",
            labels: { rig: "1", "rig-app": "app", "rig-kind": "w" },
            tags: { items: ["app-w-0a1b2c3d"] },
            disks: [
                { boot: true, autoDelete: true, initializeParams: { sourceImage: expect.stringContaining("arm64") } },
            ],
        });

        expect(bodies[0]).not.toHaveProperty("scheduling");
    });

    it("asks for a spot machine that is deleted on a take-back", async () => {
        const { provider, bodies } = inserted();

        await provider.create({ ...PLACE, market: Market.SPOT }, SPEC);

        expect(bodies[0]).toMatchObject({
            scheduling: { provisioningModel: "SPOT", instanceTerminationAction: "DELETE" },
        });
    });

    it("keeps a long name under 63 characters, with its random end", async () => {
        const { provider } = inserted();
        const name = `${"a".repeat(32)}-${"k".repeat(32)}-0a1b2c3d`;
        const answer = await provider.create(PLACE, { ...SPEC, name });
        const id = (answer as { ok: { id: string } }).ok.id.split("/")[1]!;

        expect(id.length).toBe(63);
        expect(id.endsWith("-0a1b2c3d")).toBe(true);
    });

    it("waits for the operation, and turns its error into a busy answer by the data file", async () => {
        const answer = async (code: string) => {
            const { provider } = inserted({
                "POST projects/p/zones/us-central1-a/instances": () => {
                    return { status: "RUNNING", selfLink: "https://x/operations/o" };
                },
                "POST https://x/operations/o/wait": () => {
                    return { status: "DONE", error: { errors: [{ code, message: code }] } };
                },
            });

            return provider.create(PLACE, SPEC);
        };

        expect(await answer("ZONE_RESOURCE_POOL_EXHAUSTED")).toMatchObject({ busy: "zone" });

        const thrown = inserted({
            "POST projects/p/zones/us-central1-a/instances": () => {
                throw new GceError("quotaExceeded", "quota");
            },
        });

        expect(await thrown.provider.create(PLACE, SPEC)).toMatchObject({ busy: "account" });
        expect(await answer("QUOTA_EXCEEDED")).toMatchObject({ busy: "account" });
        await expect(answer("PERMISSION_DENIED")).rejects.toThrow("PERMISSION_DENIED");
    });
});

describe("gcp: machines", () => {
    const INSTANCE = {
        name: "app-w-1",
        zone: "https://x/zones/us-central1-a",
        status: "TERMINATED",
        machineType: "https://x/machineTypes/c4a-standard-8",
        labels: { rig: "1", "rig-app": "app" },
        creationTimestamp: "1970-01-01T00:00:01.000Z",
        scheduling: { provisioningModel: "SPOT" },
        networkInterfaces: [{ networkIP: "10.0.0.1", accessConfigs: [{ natIP: "1.2.3.4" }] }],
    };

    it("maps an instance onto a machine, and an unknown one onto null", async () => {
        const { provider } = gcp({
            "GET projects/p/zones/us-central1-a/instances/app-w-1": () => {
                return INSTANCE;
            },
            "GET projects/p/zones/us-central1-a/instances/gone": () => {
                throw new GceError("notFound", "");
            },
        });

        expect(await provider.get("us-central1-a/app-w-1")).toEqual({
            id: "us-central1-a/app-w-1",
            status: "stopped",
            market: "spot",
            type: "c4a-standard-8",
            zone: "us-central1-a",
            tags: { rig: "1", "rig-app": "app" },
            ip: { public: "1.2.3.4", private: "10.0.0.1" },
            created: 1000,
        });

        expect(await provider.get("us-central1-a/gone")).toBeNull();
    });

    it("lists by every tag, in its region only: the API filters simple labels, rig the rest", async () => {
        const { provider, calls } = gcp({
            ...REGION,
            "GET projects/p/aggregated/instances": () => {
                return {
                    items: {
                        "zones/us-central1-a": {
                            instances: [
                                INSTANCE,
                                { ...INSTANCE, name: "other", labels: { rig: "1", "rig-app": "other" } },
                            ],
                        },
                        "zones/europe-west1-b": {
                            instances: [{ ...INSTANCE, name: "far", zone: "https://x/zones/europe-west1-b" }],
                        },
                    },
                };
            },
        });

        const machines = await provider.list({ rig: "1", "rig-app": "app" });

        expect(
            machines.map((machine) => {
                return machine.id;
            }),
        ).toEqual(["us-central1-a/app-w-1"]);

        const listed = calls.find((one) => {
            return one.path.includes("aggregated/instances");
        })!.path;

        expect(decodeURIComponent(listed)).toContain('(labels.rig = "1")');
        expect(decodeURIComponent(listed)).not.toContain("rig-app");
    });

    it("ends a gone machine with no delete, still deleting its firewall rules; a known one loses them first", async () => {
        const { provider, calls } = gcp({
            "GET projects/p/zones/us-central1-a/instances/app-w-1": () => {
                return INSTANCE;
            },
            "GET projects/p/zones/us-central1-a/instances/gone": () => {
                throw new GceError("notFound", "");
            },
            "GET projects/p/global/firewalls": (_body, path) => {
                return { items: [{ name: decodeURIComponent(path).includes("gone") ? "gone-aaaa" : "app-w-1-aaaa" }] };
            },
            "DELETE projects/p/global/firewalls/.*": DONE,
            "DELETE projects/p/zones/us-central1-a/instances/app-w-1": DONE,
        });

        const deletes = (): string[] => {
            return calls
                .filter((one) => {
                    return one.method === "DELETE";
                })
                .map((one) => {
                    return one.path;
                });
        };

        await provider.end("us-central1-a/gone");

        expect(deletes()).toEqual(["projects/p/global/firewalls/gone-aaaa"]);

        await provider.end("us-central1-a/app-w-1");

        expect(deletes().slice(1)).toEqual([
            "projects/p/global/firewalls/app-w-1-aaaa",
            "projects/p/zones/us-central1-a/instances/app-w-1",
        ]);
    });

    it("refuses to stop a spot machine", async () => {
        const { provider } = gcp({
            "GET projects/p/zones/us-central1-a/instances/app-w-1": () => {
                return INSTANCE;
            },
        });

        await expect(provider.stop!("us-central1-a/app-w-1")).rejects.toMatchObject({ reason: Reason.UNSUPPORTED });
    });
});

describe("gcp: shape and presets", () => {
    const { provider } = gcp({});

    it("reads a type's shape from its name and the data file", async () => {
        expect(await provider.shape!("c4a-standard-8")).toEqual({ cpu: 8, mem: 32, arch: "arm" });
        expect(await provider.shape!("n2-highcpu-16")).toEqual({ cpu: 16, mem: 32, arch: "x86" });
        expect(await provider.shape!("e2-small")).toEqual({ cpu: 2, mem: 2, arch: "x86" });
        expect(await provider.shape!("g2-standard-4")).toEqual({ cpu: 4, mem: 16, gpu: "l4", arch: "x86" });
        expect(await provider.shape!("a2-highgpu-1g")).toEqual({ cpu: 12, mem: 85, gpu: "a100", arch: "x86" });
        expect(await provider.shape!("n1-ultramem-40")).toBeNull();
    });

    it("makes the same five presets: arm first, then x86", () => {
        expect(provider.presets.compute({ name: "w" }).try[0]).toEqual({
            provider: "gcp",
            market: [Market.SPOT, Market.DEMAND],
            types: ["c4a-highcpu-4", "c3-highcpu-4", "n2-highcpu-4", "e2-highcpu-4"],
        });

        expect(provider.presets.gpu({ name: "t" }).try[0]!.types).toEqual(["g2-standard-4", "g2-standard-8"]);

        expect(provider.presets.memory({ name: "db", mem: 64, arch: PresetArch.X86 }).try[0]!.types).toEqual([
            "n4-highmem-8",
            "n2-highmem-8",
            "e2-highmem-8",
        ]);
    });
});

describe("gcp: with the core", () => {
    it("checks at open, and creates a machine from a preset", async () => {
        const { provider, calls } = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return { items: { "zones/us-central1-a": { machineTypes: [{ name: "t2a-standard-1" }] } } };
            },
            "GET projects/p/aggregated/instances": () => {
                return { items: {} };
            },
            "POST projects/p/zones/us-central1-a/instances": DONE,
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [provider.presets.small({ name: "dev" })],
            store: mkdtempSync(join(tmpdir(), "rig-gcp-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(calls[0]!.path).toBe("projects/p/regions/us-central1");

        expect(await rig.machine.create("dev")).toMatchObject({
            provider: "gcp",
            kind: "dev",
            market: "demand",
            zone: "us-central1-a",
        });
    });
});
