import { describe, expect, it } from "vitest";

import { Market, Distro } from "@diphyx/rig";

import { createAzure } from "../src/index.js";
import { cleanEach, type Handler, ok, failed, fake, VM, NSG, IMAGES, NETWORK, azure, PLACE, SPEC } from "./fake.js";

cleanEach();

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

    const made = (routes: Record<string, Handler> = {}, identity?: string) => {
        const bodies: { path: string; body: Record<string, unknown> }[] = [];
        /* The given routes first, so they win over the defaults that would match too. */
        const { request, calls } = fake({
            ...routes,
            ...NETWORK,
            [`PUT ${VM}/.*`]: (body, path) => {
                bodies.push({ path: path.split("?")[0]!, body: body! });

                return ok();
            },
            [`DELETE ${VM}/.*`]: () => {
                return ok();
            },
            ...routes,
        });

        const provider = createAzure({
            region: "eastus",
            ...(identity && { identity }),
            extra: { subscription: "s", request },
        });

        return { provider, bodies, calls };
    };

    it("boots the entry's image as it is: a resource id, a URN with its version, or one without as an id", async () => {
        const { provider, bodies, calls } = made();

        await provider.create(PLACE, { ...SPEC, image: "/images/mine" });
        await provider.create(PLACE, { ...SPEC, image: "Canonical:offer:sku:1.2.3" });
        await provider.create(PLACE, { ...SPEC, image: "Canonical:offer:sku" });

        const images = bodies.map((one) => {
            return (one.body.properties as { storageProfile: { imageReference: unknown } }).storageProfile
                .imageReference;
        });

        expect(images).toEqual([
            { id: "/images/mine" },
            { publisher: "Canonical", offer: "offer", sku: "sku", version: "1.2.3" },
            { id: "Canonical:offer:sku" },
        ]);

        expect(
            calls.some((one) => {
                return one.path.includes("/versions");
            }),
        ).toBe(false);
    });

    it("runs as the identity given, in a region without zones, sized to the disk asked for", async () => {
        const { provider, bodies } = made({}, "/identities/rig");

        await provider.create({ ...PLACE, zone: "eastus" }, { ...SPEC, disk: 40 });

        expect(bodies[0]!.body).toMatchObject({
            identity: { type: "UserAssigned", userAssignedIdentities: { "/identities/rig": {} } },
            properties: { storageProfile: { osDisk: { diskSizeGB: 40 } } },
        });

        expect(bodies[0]!.body).not.toHaveProperty("zones");
    });

    it("cuts a name over 64 characters, keeping its random end, and tags it with its rig name", async () => {
        const { provider, bodies } = made();
        const name = `${"a".repeat(70)}-0a1b2c3d`;

        await provider.create(PLACE, { ...SPEC, name, tags: { rig: "1" } });

        const short = `${"a".repeat(55)}-0a1b2c3d`;

        expect(bodies[0]!.path).toBe(`${VM}/${short}`);
        expect(bodies[0]!.body).toMatchObject({ tags: { rig: "1", "rig-name": short } });
    });

    it("takes the newest version, a missing part as 0; a missing image list is busy type; another error throws", async () => {
        const versions = made({
            [`GET ${IMAGES}/.*/versions`]: () => {
                return ok([{ name: "1.9.1" }, { name: "1.9" }, {}, { name: "1.9.1" }]);
            },
        });

        await versions.provider.create(PLACE, SPEC);

        expect(versions.bodies[0]!.body).toMatchObject({
            properties: { storageProfile: { imageReference: { version: "1.9.1" } } },
        });

        const missing = made({
            [`GET ${IMAGES}/.*/versions`]: () => {
                return failed(404, "NotFound");
            },
        });

        expect(await missing.provider.create(PLACE, SPEC)).toMatchObject({ busy: "type" });

        const denied = made({
            [`GET ${IMAGES}/.*/versions`]: () => {
                return failed(403, "AuthorizationFailed");
            },
        });

        await expect(denied.provider.create(PLACE, SPEC)).rejects.toThrow("AuthorizationFailed");
    });

    it("throws for a distro on a size the data file does not know, as its arch is unknown", async () => {
        const { provider } = made();

        await expect(provider.create({ ...PLACE, type: "Basic_A1" }, SPEC)).rejects.toThrow(
            /Basic_A1 is not in the data file, so its arch is unknown/,
        );
    });

    it("makes its network again on the next create after a first try fails", async () => {
        let groups = 0;

        const { provider } = made({
            "PUT /subscriptions/s/resourcegroups/rig": () => {
                groups += 1;

                return groups === 1 ? failed(500, "InternalServerError") : ok();
            },
        });

        await expect(provider.create(PLACE, SPEC)).rejects.toThrow("InternalServerError");
        expect(await provider.create(PLACE, SPEC)).toEqual({ ok: { id: "app-w-0a1b2c3d" } });
        expect(groups).toBe(2);
    });
});
