import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRig, Market, Distro, Reason, type Refusal } from "@diphyx/rig";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveAuth } from "../src/auth.js";
import { subscriptionOf } from "../src/config.js";
import { AuthFrom, createAzure } from "../src/index.js";

type Answer = { status: number; body: unknown; headers: Record<string, string> };
type Handler = (body: Record<string, unknown> | undefined, path: string) => Answer;

function ok(body: unknown = {}): Answer {
    return { status: 200, body, headers: {} };
}

function failed(status: number, code: string, inner?: string): Answer {
    return {
        status,
        body: { error: { code, message: code, ...(inner && { details: [{ code: inner, message: inner }] }) } },
        headers: {},
    };
}

/* A fake Azure Resource Manager: routes by `METHOD path`, a regex on the path without its query; every call is kept. */
function fake(routes: Record<string, Handler>) {
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

const RG = "/subscriptions/s/resourceGroups/rig";
const VM = `${RG}/providers/Microsoft.Compute/virtualMachines`;
const NSG = `${RG}/providers/Microsoft.Network/networkSecurityGroups`;
const IMAGES = "/subscriptions/s/providers/Microsoft.Compute/locations/eastus/publishers";

const NETWORK = {
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

function azure(routes: Record<string, Handler>, extra: Record<string, unknown> = {}) {
    const { request, calls } = fake(routes);

    return { provider: createAzure({ region: "eastus", extra: { subscription: "s", request, ...extra } }), calls };
}

const PLACE = { market: Market.DEMAND, type: "Standard_D4ps_v6", zone: "eastus-1" } as const;

const SPEC = {
    name: "app-w-0a1b2c3d",
    tags: { rig: "1", "rig-app": "app", "rig-kind": "w", "rig-name": "app-w-0a1b2c3d" },
    ports: [],
    distro: { name: Distro.UBUNTU, version: "24.04" },
};

beforeEach(() => {
    delete process.env.AZURE_SUBSCRIPTION_ID;
    delete process.env.RIG_AZURE_SUBSCRIPTION;
    delete process.env.RIG_AZURE_EU_SUBSCRIPTION;
});

describe("azure: factory", () => {
    it("takes the standard config, azure's own under extra, and refuses any other key", () => {
        expect(azure({}).provider).toMatchObject({ name: "azure", rig: 1, keys: ["tenant", "id", "secret"] });

        expect(() => {
            return createAzure({ region: "eastus", group: "g" } as never);
        }).toThrow(/unknown key group; azure's own go in extra/);

        expect(() => {
            return createAzure({ region: "eastus" });
        }).toThrow(/subscription is required/);
    });

    it("takes the subscription given, else RIG_<NAME>_SUBSCRIPTION's, else AZURE_SUBSCRIPTION_ID's", () => {
        process.env.AZURE_SUBSCRIPTION_ID = "cloud";
        expect(subscriptionOf({}, "azure")).toBe("cloud");

        process.env.RIG_AZURE_SUBSCRIPTION = "own";
        expect(subscriptionOf({}, "azure")).toBe("own");
        expect(subscriptionOf({ extra: { subscription: "given" } }, "azure")).toBe("given");

        process.env.RIG_AZURE_EU_SUBSCRIPTION = "eu";
        expect(subscriptionOf({}, "azure-eu")).toBe("eu");

        process.env.RIG_AZURE_SUBSCRIPTION = "";
        expect(subscriptionOf({}, "azure")).toBe("cloud");
    });

    it("reads RIG_AZURE_<KEY> for a service principal", () => {
        expect(
            resolveAuth(
                "azure",
                { from: AuthFrom.ENV },
                { RIG_AZURE_TENANT: "t", RIG_AZURE_ID: "i", RIG_AZURE_SECRET: "s" },
            ),
        ).toEqual({
            tenant: "t",
            id: "i",
            secret: "s",
        });
    });
});

describe("azure: places", () => {
    it("gives each size's open zones in the region, a region without zones as one place, once per market", async () => {
        const { provider } = azure({
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_D4ps_v6",
                            locationInfo: [{ zones: ["3", "1", "2"] }],
                            restrictions: [{ type: "Zone", restrictionInfo: { zones: ["2"] } }],
                        },
                        { resourceType: "virtualMachines", name: "Standard_F4s_v2", locationInfo: [{ zones: [] }] },
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_E4s_v5",
                            restrictions: [{ type: "Location" }],
                        },
                        { resourceType: "disks", name: "Standard_D4ps_v6" },
                    ],
                });
            },
        });

        expect(
            await provider.places({
                provider: "azure",
                market: [Market.SPOT],
                types: ["Standard_D4ps_v6", "Standard_F4s_v2", "Standard_E4s_v5"],
            }),
        ).toEqual([
            { market: Market.SPOT, type: "Standard_D4ps_v6", zone: "eastus-1" },
            { market: Market.SPOT, type: "Standard_D4ps_v6", zone: "eastus-3" },
            { market: Market.SPOT, type: "Standard_F4s_v2", zone: "eastus" },
        ]);
    });
});

describe("azure: create", () => {
    const created = (routes: Record<string, Handler> = {}, extra: Record<string, unknown> = {}) => {
        const bodies: Record<string, unknown>[] = [];
        /* The given routes first, so they win over the defaults that would match too. */
        const { provider, calls } = azure(
            {
                ...routes,
                ...NETWORK,
                [`PUT ${VM}/app-w-0a1b2c3d`]: (body) => {
                    bodies.push(body!);

                    return ok();
                },
                ...routes,
            },
            extra,
        );

        return { provider, calls, bodies };
    };

    it("makes its group and network once, then one machine: zoned, tagged, arm image, deleted with its disk and card", async () => {
        const { provider, calls, bodies } = created();

        expect(await provider.create(PLACE, SPEC)).toEqual({ ok: { id: "app-w-0a1b2c3d" } });
        await provider.create(PLACE, SPEC);

        expect(
            calls.filter((one) => {
                return one.path.includes("virtualNetworks");
            }).length,
        ).toBe(1);

        expect(bodies[0]).toMatchObject({
            location: "eastus",
            zones: ["1"],
            tags: { rig: "1", "rig-app": "app", "rig-kind": "w" },
            properties: {
                hardwareProfile: { vmSize: "Standard_D4ps_v6" },
                storageProfile: { imageReference: { sku: "server-arm64" }, osDisk: { deleteOption: "Delete" } },
                osProfile: {
                    adminUsername: "rig",
                    linuxConfiguration: {
                        disablePasswordAuthentication: true,
                        ssh: {
                            publicKeys: [
                                {
                                    keyData: expect.stringMatching(
                                        /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=*$/,
                                    ),
                                },
                            ],
                        },
                    },
                },
            },
        });

        expect(bodies[0]!.properties).not.toHaveProperty("priority");
    });

    it("makes the machine's own group first, the kind's rules over a deny-all, and sets it on the card", async () => {
        const groups: Record<string, unknown>[] = [];
        const { provider, bodies, calls } = created({
            [`PUT ${NSG}/.*-nsg`]: (body) => {
                groups.push(body!);

                return ok();
            },
        });

        await provider.create(PLACE, { ...SPEC, ports: [{ port: 22, from: "1.2.3.4/32" }] });

        const order = calls.map((one) => {
            return one.path.split("?")[0]!.split("/").pop();
        });

        expect(order.indexOf("app-w-0a1b2c3d-nsg")).toBeLessThan(order.lastIndexOf("app-w-0a1b2c3d"));

        expect(groups[0]).toMatchObject({
            properties: {
                securityRules: [
                    {
                        properties: {
                            priority: 100,
                            access: "Allow",
                            destinationPortRange: "22",
                            sourceAddressPrefix: "1.2.3.4/32",
                        },
                    },
                    { name: "rig-deny", properties: { priority: 4096, access: "Deny", sourceAddressPrefix: "*" } },
                ],
            },
        });

        expect(JSON.stringify(bodies[0])).toContain(`"networkSecurityGroup":{"id":"${NSG}/app-w-0a1b2c3d-nsg"}`);
    });

    it("leaves nothing behind after a failed try: a machine kept as failed, then its group, are deleted", async () => {
        const { provider, calls } = created({
            [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                return failed(409, "ZonalAllocationFailed");
            },
        });

        expect(await provider.create(PLACE, SPEC)).toMatchObject({ busy: "zone" });

        const deletes = calls
            .filter((one) => {
                return one.method === "DELETE";
            })
            .map((one) => {
                return one.path.split("?")[0]!.split("/").at(-1);
            });

        expect(deletes).toEqual(["app-w-0a1b2c3d", "app-w-0a1b2c3d-nsg"]);
    });

    it("boots a distro's newest Marketplace version for the size's arch", async () => {
        const { provider, bodies } = created({});

        await provider.create(PLACE, SPEC);

        await provider.create(
            { ...PLACE, type: "Standard_D4s_v6" },
            { ...SPEC, distro: { name: Distro.DEBIAN, version: "12" } },
        );

        expect(bodies[0]).toMatchObject({
            properties: {
                storageProfile: {
                    imageReference: {
                        publisher: "Canonical",
                        offer: "ubuntu-24_04-lts",
                        sku: "server-arm64",
                        version: "1.10.0",
                    },
                },
            },
        });

        expect(bodies[1]).toMatchObject({
            properties: {
                storageProfile: {
                    imageReference: { publisher: "Debian", offer: "debian-12", sku: "12-gen2", version: "1.10.0" },
                },
            },
        });
    });

    it("answers busy type, making nothing, when the region has no image of the distro", async () => {
        const { provider, calls } = created({
            [`GET ${IMAGES}/Debian/.*/versions`]: () => {
                return ok([]);
            },
        });

        expect(
            await provider.create(
                { ...PLACE, type: "Standard_D4s_v6" },
                { ...SPEC, distro: { name: Distro.DEBIAN, version: "13" } },
            ),
        ).toMatchObject({ busy: "type" });

        expect(
            calls.some((one) => {
                return one.method === "PUT";
            }),
        ).toBe(false);
    });

    it("asks for a spot machine that is deleted on a take-back; takes a given subnet as it is; runs its first boot", async () => {
        const { provider, calls, bodies } = created({}, { subnet: "/subnets/mine" });

        await provider.create({ ...PLACE, market: Market.SPOT }, { ...SPEC, script: "#!/bin/bash\necho hi\n" });

        expect(
            calls.some((one) => {
                return one.path.includes("virtualNetworks");
            }),
        ).toBe(false);

        expect(bodies[0]).toMatchObject({
            properties: {
                priority: "Spot",
                evictionPolicy: "Delete",
                osProfile: {
                    adminUsername: "rig",
                    customData: Buffer.from("#!/bin/bash\necho hi\n").toString("base64"),
                },
            },
        });

        expect(JSON.stringify(bodies[0])).toContain("/subnets/mine");
        expect(JSON.stringify(bodies[0])).not.toContain("adminPassword");
    });

    it("merges extra's properties under its own, so the one try and the tags win", async () => {
        const { provider, bodies } = created();

        await provider.create(PLACE, {
            ...SPEC,
            extra: {
                properties: {
                    diagnosticsProfile: { bootDiagnostics: { enabled: true } },
                    hardwareProfile: { vmSize: "x" },
                },
                tags: {},
            },
        });

        expect(bodies[0]).toMatchObject({
            tags: { rig: "1" },
            properties: {
                diagnosticsProfile: { bootDiagnostics: { enabled: true } },
                hardwareProfile: { vmSize: "Standard_D4ps_v6" },
            },
        });
    });

    it("takes a 204 as done, with nothing to follow", async () => {
        const { provider } = created({
            [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                return { status: 204, body: null, headers: { location: "https://op/never" } };
            },
        });

        expect(await provider.create(PLACE, SPEC)).toEqual({ ok: { id: "app-w-0a1b2c3d" } });
    });

    it("waits for the operation, and turns its error, or the one inside, into a busy answer by the data file", async () => {
        const answer = async (routes: Record<string, Handler>) => {
            return created(routes).provider.create(PLACE, SPEC);
        };

        expect(
            await answer({
                [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                    return { status: 201, body: {}, headers: { "azure-asyncoperation": "https://op/1" } };
                },
                "GET https://op/1": () => {
                    return ok({ status: "Failed", error: { code: "ZonalAllocationFailed" } });
                },
            }),
        ).toMatchObject({ busy: "zone" });

        expect(
            await answer({
                [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                    return failed(409, "OperationNotAllowed", "QuotaExceeded");
                },
            }),
        ).toMatchObject({ busy: "account" });

        await expect(
            answer({
                [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                    return failed(403, "AuthorizationFailed");
                },
            }),
        ).rejects.toThrow("AuthorizationFailed");

        /* `OperationNotAllowed` is room only when it is about a quota. */
        await expect(
            answer({
                [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                    return failed(409, "OperationNotAllowed");
                },
            }),
        ).rejects.toThrow("OperationNotAllowed");
    });

    it("checks that the region is one of the subscription's", async () => {
        const { provider } = azure(NETWORK);

        await expect(provider.check!()).resolves.toBeUndefined();

        await expect(
            createAzure({
                region: "mars",
                extra: { subscription: "s", request: fake(NETWORK as Record<string, Handler>).request },
            }).check!(),
        ).rejects.toThrow(/mars is not a region/);
    });
});

describe("azure: calls", () => {
    it("starts, restarts, resizes the OS disk and reads it back; closes a rule by deleting it", async () => {
        const { provider, calls } = azure({
            [`GET ${VM}/app-w-1`]: () => {
                return ok({ properties: { storageProfile: { osDisk: { managedDisk: { id: "/disks/os-1" } } } } });
            },
            [`POST ${VM}/app-w-1/(start|restart)`]: () => {
                return ok();
            },
            "PATCH /disks/os-1": (body) => {
                return ok(body);
            },
            "GET /disks/os-1": () => {
                return ok({ properties: { diskSizeGB: 60, provisioningState: "Updating" } });
            },
            [`DELETE ${NSG}/app-w-1-nsg/securityRules/rig-aaaa`]: () => {
                return ok();
            },
        });

        await provider.start!("app-w-1");
        await provider.reboot("app-w-1");
        await provider.disk!.grow("app-w-1", 60);

        expect(await provider.disk!.get("app-w-1")).toEqual({ gb: 60, ready: false });

        await provider.port!.close("app-w-1", "rig-aaaa");

        const sent = calls.map((one) => {
            return `${one.method} ${one.path.split("?")[0]}`;
        });

        expect(sent).toContain(`POST ${VM}/app-w-1/start`);
        expect(sent).toContain(`POST ${VM}/app-w-1/restart`);
        expect(sent).toContain(`DELETE ${NSG}/app-w-1-nsg/securityRules/rig-aaaa`);

        expect(
            calls.find((one) => {
                return one.method === "PATCH";
            })!.body,
        ).toEqual({ properties: { diskSizeGB: 60 } });
    });
});

describe("azure: machines", () => {
    const VMBODY = {
        name: "app-w-1",
        location: "eastus",
        zones: ["2"],
        tags: { rig: "1", "rig-app": "app" },
        properties: {
            priority: "Spot",
            timeCreated: "1970-01-01T00:00:01.000Z",
            hardwareProfile: { vmSize: "Standard_D4ps_v6" },
            networkProfile: { networkInterfaces: [{ id: "/nic/1" }] },
            instanceView: { statuses: [{ code: "ProvisioningState/succeeded" }, { code: "PowerState/deallocated" }] },
        },
    };

    it("maps a machine, with its addresses from its card and IP; an unknown one is null", async () => {
        const { provider } = azure({
            [`GET ${VM}/app-w-1`]: () => {
                return ok(VMBODY);
            },
            [`GET ${VM}/gone`]: () => {
                return failed(404, "ResourceNotFound");
            },
            "GET /nic/1": () => {
                return ok({
                    properties: {
                        ipConfigurations: [
                            { properties: { privateIPAddress: "10.42.0.4", publicIPAddress: { id: "/pip/1" } } },
                        ],
                    },
                });
            },
            "GET /pip/1": () => {
                return ok({ properties: { ipAddress: "1.2.3.4" } });
            },
        });

        expect(await provider.get("app-w-1")).toEqual({
            id: "app-w-1",
            status: "stopped",
            market: "spot",
            type: "Standard_D4ps_v6",
            zone: "eastus-2",
            tags: { rig: "1", "rig-app": "app" },
            ip: { public: "1.2.3.4", private: "10.42.0.4" },
            created: 1000,
        });

        expect(await provider.get("gone")).toBeNull();
    });

    it("lists by every tag, in its region only, every page; a group not made yet lists none", async () => {
        const { provider } = azure({
            [`GET ${VM}`]: () => {
                return ok({
                    value: [VMBODY, { ...VMBODY, name: "far", location: "westeurope" }],
                    nextLink: "https://next/2",
                });
            },
            "GET https://next/2": () => {
                return ok({ value: [{ ...VMBODY, name: "other", tags: { rig: "1", "rig-app": "other" } }] });
            },
            [`GET ${RG}/providers/Microsoft.Network/networkInterfaces`]: () => {
                return ok({
                    value: [
                        {
                            id: "/NIC/1",
                            properties: {
                                ipConfigurations: [
                                    { properties: { privateIPAddress: "10.0.0.4", publicIPAddress: { id: "/pip/1" } } },
                                ],
                            },
                        },
                    ],
                });
            },
            [`GET ${RG}/providers/Microsoft.Network/publicIPAddresses`]: () => {
                return ok({ value: [{ id: "/pip/1", properties: { ipAddress: "20.1.2.3" } }] });
            },
        });

        expect(await provider.list({ rig: "1", "rig-app": "app" })).toMatchObject([
            { id: "app-w-1", ip: { public: "20.1.2.3", private: "10.0.0.4" } },
        ]);

        const empty = azure({
            [`GET ${VM}`]: () => {
                return failed(404, "ResourceGroupNotFound");
            },
        });

        expect(await empty.provider.list({ rig: "1" })).toEqual([]);
    });

    it("ends a machine, then its security group; a group still held waits; a sweep removes those of gone machines", async () => {
        const { provider, calls } = azure({
            [`DELETE ${VM}/app-w-1`]: () => {
                return ok();
            },
            [`DELETE ${VM}/gone`]: () => {
                return failed(404, "ResourceNotFound");
            },
            [`DELETE ${NSG}/app-w-1-nsg`]: () => {
                return failed(400, "InUseNetworkSecurityGroupCannotBeDeleted");
            },
            [`DELETE ${NSG}/.*-nsg`]: () => {
                return ok();
            },
            [`GET ${NSG}`]: () => {
                return ok({
                    value: [
                        { name: "old-nsg", tags: { "rig-machine": "old" } },
                        { name: "live-nsg", tags: { "rig-machine": "live" } },
                    ],
                });
            },
            [`GET ${VM}/old`]: () => {
                return failed(404, "ResourceNotFound");
            },
            [`GET ${VM}/live`]: () => {
                return ok(VMBODY);
            },
        });

        await provider.end("app-w-1");
        await provider.end("gone");

        const deletes = calls
            .filter((one) => {
                return one.method === "DELETE";
            })
            .map((one) => {
                return one.path.split("?")[0]!.split("/").pop();
            });

        expect(deletes).toEqual(["app-w-1", "app-w-1-nsg", "old-nsg", "gone", "gone-nsg", "old-nsg"]);
    });

    it("refuses to stop a spot machine, and deallocates a demand one", async () => {
        const { provider, calls } = azure({
            [`GET ${VM}/app-w-1`]: () => {
                return ok(VMBODY);
            },
            [`GET ${VM}/box`]: () => {
                return ok({ ...VMBODY, name: "box", properties: { ...VMBODY.properties, priority: "Regular" } });
            },
            [`POST ${VM}/box/deallocate`]: () => {
                return ok();
            },
        });

        await expect(provider.stop!("app-w-1")).rejects.toMatchObject({
            reason: Reason.UNSUPPORTED,
        } satisfies Partial<Refusal>);

        await provider.stop!("box");

        expect(calls.at(-1)!.path).toContain("/box/deallocate");
    });
});

describe("azure: ports", () => {
    const GROUPBODY = {
        tags: { "rig-machine": "app-w-1", "rig-made": "0" },
        properties: {
            securityRules: [
                {
                    name: "rig-aaaa",
                    properties: {
                        priority: 100,
                        protocol: "Tcp",
                        sourceAddressPrefix: "1.2.3.4/32",
                        destinationPortRange: "22",
                    },
                },
                { name: "rig-deny", properties: { priority: 4096, access: "Deny" } },
            ],
        },
    };

    it("opens one rule on its own, below the deny-all; lists only the rules that open ports", async () => {
        const put: Record<string, unknown>[] = [];
        const { provider } = azure({
            [`GET ${NSG}/app-w-1-nsg`]: () => {
                return ok(GROUPBODY);
            },
            [`PUT ${NSG}/app-w-1-nsg/securityRules/rig-.*`]: (body) => {
                put.push(body!);

                return ok();
            },
        });

        await provider.port!.open("app-w-1", { port: 443, from: "::/0" });

        expect(put).toMatchObject([
            {
                properties: {
                    priority: 101,
                    access: "Allow",
                    destinationPortRange: "443",
                    sourceAddressPrefix: "::/0",
                },
            },
        ]);

        expect(await provider.port!.list("app-w-1")).toEqual([
            { id: "rig-aaaa", port: 22, protocol: "tcp", from: "1.2.3.4/32" },
        ]);
    });
});

describe("azure: shape and presets", () => {
    const { provider } = azure({});

    it("reads a size's shape from its name and the data file: p is arm, l is low memory", async () => {
        expect(await provider.shape!("Standard_D4ps_v6")).toEqual({ cpu: 4, mem: 16, arch: "arm" });
        expect(await provider.shape!("Standard_D4pls_v6")).toEqual({ cpu: 4, mem: 8, arch: "arm" });
        expect(await provider.shape!("Standard_F8s_v2")).toEqual({ cpu: 8, mem: 16, arch: "x86" });
        expect(await provider.shape!("Standard_E8as_v5")).toEqual({ cpu: 8, mem: 64, arch: "x86" });
        expect(await provider.shape!("Standard_NC4as_T4_v3")).toEqual({ cpu: 4, mem: 28, gpu: "t4", arch: "x86" });
        expect(await provider.shape!("Standard_M128s")).toBeNull();
    });

    it("makes the same five presets: arm first, then x86", () => {
        expect(provider.presets.compute({ name: "w" }).try[0]).toEqual({
            provider: "azure",
            market: [Market.SPOT, Market.DEMAND],
            types: ["Standard_D4pls_v6", "Standard_D4pls_v5", "Standard_F4as_v6", "Standard_F4s_v2"],
        });

        expect(provider.presets.gpu({ name: "t" }).try[0]!.types).toEqual([
            "Standard_NC4as_T4_v3",
            "Standard_NC8as_T4_v3",
        ]);
    });
});

describe("azure: with the core", () => {
    it("takes a full spot quota as no room in spot, and makes the machine on demand", async () => {
        const { provider } = azure({
            ...NETWORK,
            "GET /subscriptions/s": () => {
                return ok();
            },
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        { resourceType: "virtualMachines", name: "Standard_D4ps_v6", locationInfo: [{ zones: ["1"] }] },
                    ],
                });
            },
            [`GET ${VM}`]: () => {
                return ok({ value: [] });
            },
            [`PUT ${VM}/.*`]: (body) => {
                return (body?.properties as { priority?: string }).priority === "Spot"
                    ? failed(409, "OperationNotAllowed", "QuotaExceeded")
                    : ok();
            },
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [
                {
                    name: "w",
                    try: [{ provider: "azure", market: [Market.SPOT, Market.DEMAND], types: ["Standard_D4ps_v6"] }],
                },
            ],
            store: mkdtempSync(join(tmpdir(), "rig-azure-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(await rig.machine.create("w")).toMatchObject({ market: "demand" });
    });

    it("checks at open, and creates a machine from a preset", async () => {
        const { provider, calls } = azure({
            ...NETWORK,
            "GET /subscriptions/s": () => {
                return ok();
            },
            "GET /subscriptions/s/providers/Microsoft.Compute/skus": () => {
                return ok({
                    value: [
                        {
                            resourceType: "virtualMachines",
                            name: "Standard_B2pls_v2",
                            locationInfo: [{ zones: ["1"] }],
                        },
                    ],
                });
            },
            [`GET ${VM}`]: () => {
                return ok({ value: [] });
            },
            [`PUT ${VM}/.*`]: () => {
                return ok();
            },
        });

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [provider.presets.small({ name: "dev" })],
            store: mkdtempSync(join(tmpdir(), "rig-azure-")),
            extra: { rounds: false },
        });

        await rig.open();

        expect(calls[0]!.path).toBe("/subscriptions/s?api-version=2022-12-01");

        expect(await rig.machine.create("dev")).toMatchObject({
            provider: "azure",
            kind: "dev",
            market: "demand",
            zone: "eastus-1",
        });
    });
});
