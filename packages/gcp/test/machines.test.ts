import { describe, expect, it } from "vitest";

import { Reason } from "@diphyx/rig";

import { GceError } from "../src/index.js";

import { DONE, gcp, REGION } from "./fake.js";

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

    it("maps a bare instance onto a pending demand machine with no ip, made at 0", async () => {
        const { provider } = gcp({
            "GET projects/p/zones/us-central1-a/instances/x": () => {
                return {};
            },
        });

        expect(await provider.get("us-central1-a/x")).toEqual({
            id: "/",
            status: "pending",
            market: "demand",
            type: "",
            zone: "",
            tags: {},
            created: 0,
        });
    });

    it("throws a failed read that is not a missing machine", async () => {
        const { provider } = gcp({
            "GET projects/p/zones/us-central1-a/instances/x": () => {
                throw new GceError("forbidden", "no access");
            },
        });

        await expect(provider.get("us-central1-a/x")).rejects.toThrow("no access");
    });

    it("lists with no tags unfiltered, reading every page, an empty one too", async () => {
        const { provider, calls } = gcp({
            ...REGION,
            "GET projects/p/aggregated/instances": (_body, path) => {
                return path.includes("pageToken=")
                    ? {}
                    : {
                          items: {
                              "zones/us-central1-a": {
                                  instances: [{ name: "a", zone: "https://x/zones/us-central1-a" }],
                              },
                          },
                          nextPageToken: "t",
                      };
            },
        });

        expect(
            (await provider.list({})).map((machine) => {
                return machine.id;
            }),
        ).toEqual(["us-central1-a/a"]);

        expect(
            calls
                .filter((one) => {
                    return one.path.includes("aggregated/instances");
                })
                .map((one) => {
                    return one.path;
                }),
        ).toEqual(["projects/p/aggregated/instances", "projects/p/aggregated/instances?pageToken=t"]);
    });

    it("stops a demand machine", async () => {
        const { provider, calls } = gcp({
            "GET projects/p/zones/us-central1-a/instances/x": () => {
                return { name: "x" };
            },
            "POST projects/p/zones/us-central1-a/instances/x/stop": DONE,
        });

        await provider.stop!("us-central1-a/x");

        expect(
            calls.some((one) => {
                return one.method === "POST" && one.path.endsWith("/x/stop");
            }),
        ).toBe(true);
    });

    it("ends a machine Compute Engine deleted meanwhile, and throws any other failed delete", async () => {
        const failing = (code: string) => {
            return gcp({
                "GET projects/p/zones/us-central1-a/instances/x": () => {
                    return { name: "x" };
                },
                "DELETE projects/p/zones/us-central1-a/instances/x": () => {
                    throw new GceError(code, code);
                },
            });
        };

        await failing("notFound").provider.end("us-central1-a/x");
        await expect(failing("forbidden").provider.end("us-central1-a/x")).rejects.toThrow("forbidden");
    });

    it("deletes a rule with no name by an empty one", async () => {
        const { provider, calls } = gcp({
            "GET projects/p/zones/us-central1-a/instances/x": () => {
                throw new GceError("notFound", "");
            },
            "GET projects/p/global/firewalls": () => {
                return { items: [{}] };
            },
        });

        await provider.end("us-central1-a/x");

        expect(
            calls.find((one) => {
                return one.method === "DELETE";
            })!.path,
        ).toBe("projects/p/global/firewalls/");
    });
});
