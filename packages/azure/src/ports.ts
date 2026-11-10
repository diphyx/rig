import { randomBytes } from "node:crypto";

import { Proto, type Rule } from "@diphyx/rig";

import { type Arm, codeOf, gone } from "./arm.js";
import { API, type Paths, versioned } from "./paths.js";

type SecurityRule = {
    name?: string;
    properties?: { protocol?: string; sourceAddressPrefix?: string; destinationPortRange?: string; priority?: number };
};

type Nsg = { name?: string; tags?: Record<string, string>; properties?: { securityRules?: SecurityRule[] } };

/* The tag on the security group rig makes for one machine: its name. */
const GROUP = "rig-machine";

type Nic = { properties?: { networkSecurityGroup?: { id?: string } } } & Record<string, unknown>;

/** A machine's ports: a network security group of its own, made on the first `open` and set on its network card. */
export function createPorts(arm: Arm, path: Paths, region: string) {
    async function nsgOf(vm: string): Promise<Nsg | null> {
        try {
            return (await arm.send("GET", versioned(path.nsg(vm), API.network))).body as Nsg;
        } catch (error) {
            if (gone(error)) {
                return null;
            }

            throw error;
        }
    }

    /* A group gone, or one Azure still holds while the machine's card goes, is not an error. */
    async function remove(nsg: string): Promise<void> {
        try {
            await arm.done("DELETE", versioned(nsg, API.network));
        } catch (error) {
            if (!gone(error) && codeOf(error) !== "InUseNetworkSecurityGroupCannotBeDeleted") {
                throw error;
            }
        }
    }

    /* The machine's network card gets the group, once. */
    async function attach(vm: string): Promise<void> {
        const machine = (await arm.send("GET", versioned(path.vm(vm), API.compute))).body as {
            properties?: { networkProfile?: { networkInterfaces?: { id?: string }[] } };
        };

        const nic = machine.properties?.networkProfile?.networkInterfaces?.[0]?.id;

        if (!nic) {
            throw new Error(`azure: ${vm} has no network card`);
        }

        const card = (await arm.send("GET", versioned(nic, API.network))).body as Nic;

        if (card.properties?.networkSecurityGroup?.id) {
            return;
        }

        await arm.done("PUT", versioned(nic, API.network), {
            ...card,
            properties: { ...card.properties, networkSecurityGroup: { id: path.nsg(vm) } },
        });
    }

    return {
        async open(vm: string, rule: Rule): Promise<Rule> {
            const rules = (await nsgOf(vm))?.properties?.securityRules ?? [];
            const name = `rig-${randomBytes(4).toString("hex")}`;

            const priority =
                100 +
                rules.reduce((top, one) => {
                    return Math.max(top, (one.properties?.priority ?? 100) - 100 + 1);
                }, 0);

            const ports =
                rule.to !== undefined && rule.to !== rule.port ? `${rule.port}-${rule.to}` : String(rule.port);

            await arm.done("PUT", versioned(path.nsg(vm), API.network), {
                location: region,
                tags: { [GROUP]: vm },
                properties: {
                    securityRules: [
                        ...rules,
                        {
                            name,
                            properties: {
                                priority,
                                direction: "Inbound",
                                access: "Allow",
                                protocol: rule.proto === Proto.UDP ? "Udp" : "Tcp",
                                sourceAddressPrefix: rule.from,
                                sourcePortRange: "*",
                                destinationAddressPrefix: "*",
                                destinationPortRange: ports,
                            },
                        },
                    ],
                },
            });

            await attach(vm);

            return { ...rule, id: name };
        },

        async close(vm: string, rule: string): Promise<void> {
            try {
                await arm.done("DELETE", versioned(`${path.nsg(vm)}/securityRules/${rule}`, API.network));
            } catch (error) {
                if (!gone(error)) {
                    throw error;
                }
            }
        },

        async list(vm: string): Promise<Rule[]> {
            return ((await nsgOf(vm))?.properties?.securityRules ?? []).map((one) => {
                const [from = "", to] = (one.properties?.destinationPortRange ?? "0").split("-");

                return {
                    id: one.name ?? "",
                    port: Number(from),
                    ...(to !== undefined && { to: Number(to) }),
                    proto: one.properties?.protocol === "Udp" ? Proto.UDP : Proto.TCP,
                    from: one.properties?.sourceAddressPrefix ?? "",
                };
            });
        },

        /** §11: after the machine is gone, its group goes too; one Azure still holds is left for `sweep`. */
        async release(vm: string): Promise<void> {
            await remove(path.nsg(vm));
        },

        /** §11: the groups of machines that are gone, deleted once nothing holds them. */
        async sweep(exists: (vm: string) => Promise<boolean>): Promise<void> {
            let groups: Nsg[];

            try {
                groups = await arm.all<Nsg>(path.nsgs);
            } catch (error) {
                if (gone(error)) {
                    return;
                }

                throw error;
            }

            for (const group of groups) {
                const vm = group.tags?.[GROUP];

                if (vm && !(await exists(vm))) {
                    await remove(path.nsg(vm));
                }
            }
        },
    };
}
