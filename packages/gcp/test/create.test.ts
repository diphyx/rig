import { describe, expect, it } from "vitest";

import { Distro, Market } from "@diphyx/rig";

import { createGcp, GceError } from "../src/index.js";

import { DONE, fake, FIREWALLS, gcp, type Handler, PLACE, SPEC } from "./fake.js";

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

    it("boots the entry's own image as it is, with no family looked up", async () => {
        const bodies: Record<string, unknown>[] = [];
        const { provider, calls } = gcp({
            "POST projects/p/zones/us-central1-a/instances": (body) => {
                bodies.push(body!);

                return { status: "DONE" };
            },
        });

        const image = "projects/x/global/images/y";

        await provider.create({ ...PLACE, type: "zz9-odd" }, { ...SPEC, image, disk: 40 });

        expect(bodies[0]).toMatchObject({
            disks: [{ initializeParams: { sourceImage: image, diskSizeGb: "40" } }],
            metadata: { items: [{ key: "rig-image", value: image }, { key: "rig-name" }] },
        });

        expect(
            calls.some((one) => {
                return one.path.includes("/images/family/");
            }),
        ).toBe(false);
    });

    it("names a machine with no rig-name tag by its spec name, on the subnet and as the identity given", async () => {
        const bodies: Record<string, unknown>[] = [];
        const { request } = fake({
            ...FIREWALLS,
            "POST projects/p/zones/us-central1-a/instances": (body) => {
                bodies.push(body!);

                return { status: "DONE" };
            },
        });

        const provider = createGcp({
            region: "us-central1",
            identity: "run@p.iam.gserviceaccount.com",
            extra: {
                project: "p",
                network: "global/networks/main",
                subnet: "regions/us-central1/subnetworks/main",
                request,
            },
        });

        await provider.create(PLACE, { ...SPEC, tags: { rig: "1" } });

        expect(bodies[0]).toMatchObject({
            labels: { rig: "1", "rig-name": "app-w-0a1b2c3d" },
            networkInterfaces: [
                { network: "global/networks/main", subnetwork: "regions/us-central1/subnetworks/main" },
            ],
            metadata: { items: [{ key: "rig-image" }, { key: "rig-name", value: "app-w-0a1b2c3d" }] },
            serviceAccounts: [{ email: "run@p.iam.gserviceaccount.com" }],
        });
    });

    it("throws a failed image lookup that is not a missing family", async () => {
        const { provider } = gcp({
            "GET projects/[^/]+/global/images/family/.*": () => {
                throw new GceError("forbidden", "no access");
            },
        });

        await expect(provider.create(PLACE, SPEC)).rejects.toMatchObject({ code: "forbidden" });
    });

    it("throws an operation's error with no code or message as an unknown one", async () => {
        const { provider } = gcp({
            "POST projects/p/zones/us-central1-a/instances": () => {
                return { status: "DONE", error: { errors: [{}] } };
            },
        });

        await expect(provider.create(PLACE, SPEC)).rejects.toMatchObject({ code: "unknown", message: "" });
    });

    it("throws the first failed firewall rule's error as it is, releasing the rest, making no machine", async () => {
        const { provider, calls } = gcp({
            "POST projects/p/global/firewalls": (body) => {
                if (String(body?.name).endsWith("-deny6")) {
                    throw new GceError("quotaExceeded", "firewalls");
                }

                if (String(body?.name).endsWith("-deny4")) {
                    return DONE();
                }

                throw new GceError("forbidden", "rule");
            },
            "GET projects/p/global/firewalls": () => {
                return { items: [{ name: "app-w-0a1b2c3d-deny4" }] };
            },
        });

        await expect(
            provider.create(PLACE, { ...SPEC, ports: [{ port: 22, from: "1.2.3.4/32" }] }),
        ).rejects.toMatchObject({ code: "quotaExceeded", message: "firewalls" });

        expect(
            calls
                .filter((one) => {
                    return one.method === "DELETE";
                })
                .map((one) => {
                    return one.path;
                }),
        ).toEqual(["projects/p/global/firewalls/app-w-0a1b2c3d-deny4"]);

        expect(
            calls.some((one) => {
                return one.path.endsWith("/instances");
            }),
        ).toBe(false);
    });
});
