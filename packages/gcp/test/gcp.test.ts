import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRig, Market, Distro, PresetArch, Reason, Refusal } from "@diphyx/rig";
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

/* The machine's own firewall rules: made, listed, deleted. */
const FIREWALLS: Record<string, Handler> = {
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

function gcp(routes: Record<string, Handler>) {
    const { request, calls } = fake({ ...routes, ...FIREWALLS, ...routes });

    return { provider: createGcp({ region: "us-central1", extra: { project: "p", request } }), calls };
}

const PLACE = { market: Market.DEMAND, type: "c4a-standard-8", zone: "us-central1-a" } as const;

const SPEC = {
    name: "app-w-0a1b2c3d",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-0a1b2c3d" },
    ports: [],
    distro: { name: Distro.UBUNTU, version: "24.04" },
};

describe("gcp: factory", () => {
    it("takes the standard config, gcp's own under extra, and refuses any other key", () => {
        expect(gcp({}).provider).toMatchObject({ name: "gcp", rig: 1, keys: ["key"] });

        expect(() => {
            return createGcp({ region: "us-central1", project: "p" } as never);
        }).toThrow(/unknown key project; gcp's own go in extra/);

        /* No region: the cloud's own env var's, else its default. */
        expect(createGcp({ extra: { project: "p" } })).toMatchObject({ name: "gcp" });
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

    it("boots a distro family's newest image for the type's arch, and keeps its name on the machine", async () => {
        const { provider, bodies } = inserted();

        await provider.create(PLACE, { ...SPEC, distro: { name: Distro.DEBIAN, version: "13" } });

        expect(bodies[0]).toMatchObject({
            disks: [
                {
                    initializeParams: {
                        sourceImage:
                            "https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/debian-13-arm64-v20260101",
                    },
                },
            ],
            metadata: {
                items: [
                    { key: "rig-image", value: "debian-cloud/debian-13-arm64-v20260101" },
                    { key: "rig-name", value: "app-w-0a1b2c3d" },
                ],
            },
        });
    });

    it("deletes an instance Compute Engine kept for a failed try, then its rules", async () => {
        const { provider, calls } = gcp({
            "POST projects/p/zones/us-central1-a/instances": () => {
                throw new GceError("internalError", "");
            },
            "GET projects/p/zones/us-central1-a/instances/app-w-0a1b2c3d": () => {
                return { name: "app-w-0a1b2c3d" };
            },
            "DELETE projects/p/zones/us-central1-a/instances/app-w-0a1b2c3d": () => {
                return { status: "DONE" };
            },
        });

        await expect(provider.create(PLACE, SPEC)).rejects.toThrow();

        expect(
            calls.some((one) => {
                return one.method === "DELETE" && one.path.endsWith("/instances/app-w-0a1b2c3d");
            }),
        ).toBe(true);
    });

    it("refuses to guess the arch of a type it does not know: its entry needs an image", async () => {
        const { provider } = gcp({});

        await expect(provider.create({ ...PLACE, type: "zz9-odd" }, SPEC)).rejects.toThrow(/arch is unknown/);
    });

    it("answers busy type, making nothing, when there is no image family for the distro", async () => {
        const { provider, calls } = gcp({
            "GET projects/[^/]+/global/images/family/.*": () => {
                throw new GceError("notFound", "");
            },
        });

        expect(await provider.create(PLACE, SPEC)).toMatchObject({ busy: "type" });

        expect(
            calls.some((one) => {
                return one.method === "POST";
            }),
        ).toBe(false);
    });

    it("keeps the entry's own metadata items, with rig's first boot and image", async () => {
        const { provider, bodies } = inserted();

        await provider.create(PLACE, {
            ...SPEC,
            script: "#!/bin/bash\n",
            extra: {
                metadata: {
                    items: [
                        { key: "enable-oslogin", value: "TRUE" },
                        { key: "startup-script", value: "x" },
                    ],
                },
            },
        });

        expect(
            (bodies[0]!.metadata as { items: { key: string }[] }).items.map((item) => {
                return item.key;
            }),
        ).toEqual(["enable-oslogin", "rig-image", "rig-name", "startup-script"]);
    });

    it("denies all inbound first, IPv4 and IPv6, opens only the kind's ports, then inserts the machine", async () => {
        const { provider, calls } = gcp({
            "POST projects/p/zones/us-central1-a/instances": DONE,
        });

        await provider.create(PLACE, { ...SPEC, ports: [{ port: 22, from: "1.2.3.4/32" }] });

        const made = calls.filter((one) => {
            return one.method === "POST";
        });

        expect(
            made.map((one) => {
                return one.body?.name ?? one.path;
            }),
        ).toEqual([
            "app-w-0a1b2c3d-deny4",
            "app-w-0a1b2c3d-deny6",
            expect.stringMatching(/^app-w-0a1b2c3d-[0-9a-f]{8}$/),
            "app-w-0a1b2c3d",
        ]);

        expect(made[0]!.body).toMatchObject({
            priority: 1000,
            denied: [{ IPProtocol: "all" }],
            targetTags: ["app-w-0a1b2c3d"],
        });

        expect(made[2]!.body).toMatchObject({
            priority: 900,
            allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
            sourceRanges: ["1.2.3.4/32"],
        });
    });

    it("keeps a long name's random end in its rules' names, so two machines of a kind never share one", async () => {
        const { provider, calls } = gcp({
            "POST projects/p/zones/us-central1-a/instances": DONE,
        });

        const name = `${"a".repeat(30)}-${"k".repeat(20)}-0a1b2c3d`;

        await provider.create(PLACE, { ...SPEC, name });

        const first = calls.find((one) => {
            return one.method === "POST";
        });

        expect(first!.body?.name).toBe(`${"a".repeat(30)}-${"k".repeat(14)}-0a1b2c3d-deny4`);
    });

    it("leaves nothing behind after a failed try: its rules are deleted", async () => {
        const { provider, calls } = gcp({
            "POST projects/p/zones/us-central1-a/instances": () => {
                throw new GceError("ZONE_RESOURCE_POOL_EXHAUSTED", "");
            },
            "GET projects/p/global/firewalls": () => {
                return { items: [{ name: "app-w-0a1b2c3d-deny4" }, { name: "app-w-0a1b2c3d-deny6" }] };
            },
        });

        expect(await provider.create(PLACE, SPEC)).toMatchObject({ busy: "zone" });

        expect(
            calls
                .filter((one) => {
                    return one.method === "DELETE";
                })
                .map((one) => {
                    return one.path;
                }),
        ).toEqual([
            "projects/p/global/firewalls/app-w-0a1b2c3d-deny4",
            "projects/p/global/firewalls/app-w-0a1b2c3d-deny6",
        ]);
    });

    it("lists only the rules that open ports, never its deny-all", async () => {
        const { provider } = gcp({
            "GET projects/p/global/firewalls": () => {
                return {
                    items: [
                        { name: "x-deny4", denied: [{ IPProtocol: "all" }], sourceRanges: ["0.0.0.0/0"] },
                        {
                            name: "x-aaaa",
                            allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
                            sourceRanges: ["1.2.3.4/32"],
                        },
                    ],
                };
            },
        });

        expect(await provider.port!.list("us-central1-a/x")).toEqual([
            { id: "x-aaaa", port: 22, protocol: "tcp", from: "1.2.3.4/32" },
        ]);
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

describe("gcp: calls", () => {
    it("starts, resets, resizes the boot disk and reads it back; closes a rule by deleting it", async () => {
        const { provider, calls } = gcp({
            "GET projects/p/zones/us-central1-a/instances/app-w-1": () => {
                return { name: "app-w-1", disks: [{ boot: true, source: "https://x/disks/app-w-1" }] };
            },
            "POST projects/p/zones/us-central1-a/instances/app-w-1/(start|reset)": DONE,
            "POST projects/p/zones/us-central1-a/disks/app-w-1/resize": DONE,
            "GET projects/p/zones/us-central1-a/disks/app-w-1": () => {
                return { sizeGb: "60", status: "RESTORING" };
            },
        });

        await provider.start!("us-central1-a/app-w-1");
        await provider.reboot("us-central1-a/app-w-1");
        await provider.disk!.grow("us-central1-a/app-w-1", 60);

        expect(await provider.disk!.get("us-central1-a/app-w-1")).toEqual({ gb: 60, ready: false });

        await provider.port!.close("us-central1-a/app-w-1", "app-w-1-aaaa");

        const sent = calls.map((one) => {
            return `${one.method} ${one.path}`;
        });

        expect(sent).toContain("POST projects/p/zones/us-central1-a/instances/app-w-1/start");
        expect(sent).toContain("POST projects/p/zones/us-central1-a/instances/app-w-1/reset");
        expect(sent).toContain("DELETE projects/p/global/firewalls/app-w-1-aaaa");

        expect(
            calls.find((one) => {
                return one.path.endsWith("/resize");
            })!.body,
        ).toEqual({ sizeGb: "60" });
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

    it("reads its image, and its whole rig name, from its metadata: a label holds only 63 characters", async () => {
        const long = `${"a".repeat(32)}-${"k".repeat(32)}-0a1b2c3d`;
        const { provider } = gcp({
            "GET projects/p/zones/us-central1-a/instances/app-w-1": () => {
                return {
                    ...INSTANCE,
                    labels: { ...INSTANCE.labels, "rig-name": "cut" },
                    metadata: {
                        items: [
                            { key: "rig-image", value: "debian-cloud/debian-12-v1" },
                            { key: "rig-name", value: long },
                        ],
                    },
                };
            },
        });

        expect(await provider.get("us-central1-a/app-w-1")).toMatchObject({
            image: "debian-cloud/debian-12-v1",
            tags: { "rig-name": long },
        });
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

    it("ends a gone machine with no delete, still deleting its firewall rules; a known one goes before its rules", async () => {
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
            "projects/p/zones/us-central1-a/instances/app-w-1",
            "projects/p/global/firewalls/app-w-1-aaaa",
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
    it("takes a full spot quota as no room in spot, and makes the machine on demand", async () => {
        const { provider } = gcp({
            ...REGION,
            "GET projects/p/aggregated/machineTypes": () => {
                return { items: { "zones/us-central1-a": { machineTypes: [{ name: "c4a-standard-8" }] } } };
            },
            "GET projects/p/aggregated/instances": () => {
                return { items: {} };
            },
            "POST projects/p/zones/us-central1-a/instances": (body) => {
                return body?.scheduling
                    ? {
                          status: "DONE",
                          error: { errors: [{ code: "QUOTA_EXCEEDED", message: "Quota 'PREEMPTIBLE_CPUS' exceeded" }] },
                      }
                    : { status: "DONE" };
            },
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [
                {
                    name: "w",
                    try: [{ provider: "gcp", market: [Market.SPOT, Market.DEMAND], types: ["c4a-standard-8"] }],
                },
            ],
            store: mkdtempSync(join(tmpdir(), "rig-gcp-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(await rig.machine.create("w")).toMatchObject({ market: "demand" });
    });

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
