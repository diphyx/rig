import { describe, expect, it } from "vitest";

import { Protocol } from "@diphyx/rig";

import { cleanEach, type Handler, ok, failed, VM, NSG, azure } from "./fake.js";

cleanEach();

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

    it("opens a range and a udp rule at 100 in a group with no rules, and lists them back", async () => {
        const put: Record<string, unknown>[] = [];
        const { provider } = azure({
            [`GET ${NSG}/app-w-1-nsg`]: () => {
                return ok({});
            },
            [`PUT ${NSG}/app-w-1-nsg/securityRules/rig-.*`]: (body) => {
                put.push(body!);

                return ok();
            },
        });

        await provider.port!.open("app-w-1", { port: 1000, to: 2000, protocol: Protocol.UDP, from: "0.0.0.0/0" });
        await provider.port!.open("app-w-1", { port: 80, to: 80, from: "0.0.0.0/0" });

        expect(put).toMatchObject([
            { properties: { priority: 100, protocol: "Udp", destinationPortRange: "1000-2000" } },
            { properties: { priority: 100, protocol: "Tcp", destinationPortRange: "80" } },
        ]);

        expect(await provider.port!.list("app-w-1")).toEqual([]);
    });

    it("lists a range, a udp rule and a bare rule; ranks a rule with no priority as 0", async () => {
        const put: Record<string, unknown>[] = [];
        const { provider } = azure({
            [`GET ${NSG}/app-w-1-nsg`]: () => {
                return ok({
                    properties: {
                        securityRules: [
                            {
                                name: "rig-bbbb",
                                properties: {
                                    protocol: "Udp",
                                    sourceAddressPrefix: "::/0",
                                    destinationPortRange: "1000-2000",
                                },
                            },
                            {},
                        ],
                    },
                });
            },
            [`PUT ${NSG}/app-w-1-nsg/securityRules/rig-.*`]: (body) => {
                put.push(body!);

                return ok();
            },
        });

        expect(await provider.port!.list("app-w-1")).toEqual([
            { id: "rig-bbbb", port: 1000, to: 2000, protocol: "udp", from: "::/0" },
            { id: "", port: 0, protocol: "tcp", from: "" },
        ]);

        await provider.port!.open("app-w-1", { port: 22, from: "1.2.3.4/32" });

        expect(put).toMatchObject([{ properties: { priority: 100 } }]);
    });

    it("throws opening on a machine with no group; lists none for it; throws a group that fails to read", async () => {
        const { provider } = azure({
            [`GET ${NSG}/gone-nsg`]: () => {
                return failed(404, "ResourceNotFound");
            },
            [`GET ${NSG}/broken-nsg`]: () => {
                return failed(500, "InternalServerError");
            },
        });

        await expect(provider.port!.open("gone", { port: 22, from: "1.2.3.4/32" })).rejects.toThrow(
            /gone has no security group of its own/,
        );

        expect(await provider.port!.list("gone")).toEqual([]);
        await expect(provider.port!.list("broken")).rejects.toThrow("InternalServerError");
    });

    it("closes a rule already gone, and throws a close that fails for another reason", async () => {
        const { provider } = azure({
            [`DELETE ${NSG}/app-w-1-nsg/securityRules/rig-gone`]: () => {
                return failed(404, "NotFound");
            },
            [`DELETE ${NSG}/app-w-1-nsg/securityRules/rig-held`]: () => {
                return failed(409, "Conflict");
            },
        });

        await expect(provider.port!.close("app-w-1", "rig-gone")).resolves.toBeUndefined();
        await expect(provider.port!.close("app-w-1", "rig-held")).rejects.toThrow("Conflict");
    });

    it("ends with no sweep when the group is not made, and throws a group or sweep that fails", async () => {
        const routes = (list: Handler, group: Handler = ok) => {
            return azure({
                [`DELETE ${VM}/app-w-1`]: () => {
                    return ok();
                },
                [`DELETE ${NSG}/app-w-1-nsg`]: group,
                [`GET ${NSG}`]: list,
            }).provider;
        };

        await expect(
            routes(() => {
                return failed(404, "ResourceGroupNotFound");
            }).end("app-w-1"),
        ).resolves.toBeUndefined();

        await expect(
            routes(() => {
                return failed(500, "InternalServerError");
            }).end("app-w-1"),
        ).rejects.toThrow("InternalServerError");

        await expect(
            routes(ok, () => {
                return failed(409, "Conflict");
            }).end("app-w-1"),
        ).rejects.toThrow("Conflict");
    });
});
