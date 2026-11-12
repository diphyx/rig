import { describe, expect, it } from "vitest";

import { Reason, type Refusal } from "@diphyx/rig";

import { cleanEach, ok, failed, RG, VM, NSG, azure } from "./fake.js";

cleanEach();

describe("azure: machines", () => {
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

    it("maps a bare machine with defaults, a deleting one as ending, and its image by id or URN", async () => {
        const { provider } = azure({
            [`GET ${VM}/bare`]: () => {
                return ok({ properties: { instanceView: { statuses: [{}, { code: "PowerState/unknown" }] } } });
            },
            [`GET ${VM}/deleting`]: () => {
                return ok({
                    name: "deleting",
                    location: "eastus",
                    properties: {
                        provisioningState: "Deleting",
                        storageProfile: { imageReference: { id: "/images/mine" } },
                    },
                });
            },
            [`GET ${VM}/urn`]: () => {
                return ok({
                    name: "urn",
                    location: "eastus",
                    properties: {
                        storageProfile: {
                            imageReference: { publisher: "Canonical", offer: "o", sku: "s", exactVersion: "1.2.3" },
                        },
                        networkProfile: { networkInterfaces: [{ id: "/nic/2" }] },
                        instanceView: { statuses: [{ code: "PowerState/running" }] },
                    },
                });
            },
            "GET /nic/2": () => {
                return ok({ properties: { ipConfigurations: [{ properties: { privateIPAddress: "10.0.0.5" } }] } });
            },
        });

        expect(await provider.get("bare")).toEqual({
            id: "",
            status: "pending",
            market: "demand",
            type: "",
            zone: "",
            tags: {},
            created: 0,
        });

        expect(await provider.get("deleting")).toMatchObject({ status: "ending", image: "/images/mine" });

        expect(await provider.get("urn")).toMatchObject({
            status: "running",
            image: "Canonical:o:s:1.2.3",
            ip: { private: "10.0.0.5" },
        });
    });

    it("throws a read that fails for another reason than a 404", async () => {
        const { provider } = azure({
            [`GET ${VM}/app-w-1`]: () => {
                return failed(500, "InternalServerError");
            },
            [`GET ${VM}`]: () => {
                return failed(403, "AuthorizationFailed");
            },
        });

        await expect(provider.get("app-w-1")).rejects.toThrow("InternalServerError");
        await expect(provider.list({})).rejects.toThrow("AuthorizationFailed");
    });

    it("lists machines with no card, and cards and IPs with parts missing; addresses that fail to read are none", async () => {
        const { provider } = azure({
            [`GET ${VM}`]: () => {
                return ok({
                    value: [
                        { name: "a", location: "eastus" },
                        { name: "b", location: "eastus", properties: { networkProfile: { networkInterfaces: [{}] } } },
                    ],
                });
            },
            [`GET ${RG}/providers/Microsoft.Network/networkInterfaces`]: () => {
                return ok({ value: [{}, { id: "/nic/3", properties: { ipConfigurations: [{}] } }] });
            },
            [`GET ${RG}/providers/Microsoft.Network/publicIPAddresses`]: () => {
                return ok({ value: [{}] });
            },
        });

        expect(await provider.list({})).toMatchObject([{ id: "a" }, { id: "b" }]);

        const unread = azure({
            [`GET ${VM}`]: () => {
                return ok({ value: [{ name: "a", location: "eastus" }] });
            },
        });

        expect(await unread.provider.list({})).toMatchObject([{ id: "a" }]);
        expect((await unread.provider.list({}))[0]).not.toHaveProperty("ip");
    });
});
