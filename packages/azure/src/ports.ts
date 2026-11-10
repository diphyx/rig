import { randomBytes } from "node:crypto";

import { Proto, type Rule } from "@diphyx/rig";

import { type Arm, codeOf, gone } from "./arm.js";
import { API, type Paths, versioned } from "./paths.js";

type SecurityRule = {
    name?: string;
    properties?: {
        priority?: number;
        direction?: string;
        access?: string;
        protocol?: string;
        sourceAddressPrefix?: string;
        sourcePortRange?: string;
        destinationAddressPrefix?: string;
        destinationPortRange?: string;
    };
};

type Nsg = { name?: string; tags?: Record<string, string>; properties?: { securityRules?: SecurityRule[] } };

/* The tags on the security group rig makes for one machine: its name, and when it was made. */
const GROUP = "rig-machine";
const MADE = "rig-made";

/* A group younger than this may be a try still running: `sweep` leaves it. */
const YOUNG = 10 * 60_000;

/* The machine's deny-all: the lowest a custom rule can rank, still above the network's own allow (65000). */
const DENY = { name: "rig-deny", priority: 4096 };

/** A machine's ports: a network security group of its own, made before it with only the kind's rules, all else denied. */
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

    /* An inbound rule, as a network security group takes it. */
    function inbound(name: string, priority: number, access: string, protocol: string, from: string, ports: string) {
        return {
            name,
            properties: {
                priority,
                direction: "Inbound",
                access,
                protocol,
                sourceAddressPrefix: from,
                sourcePortRange: "*",
                destinationAddressPrefix: "*",
                destinationPortRange: ports,
            },
        } satisfies SecurityRule;
    }

    function allow(name: string, priority: number, rule: Rule): SecurityRule {
        const ports = rule.to !== undefined && rule.to !== rule.port ? `${rule.port}-${rule.to}` : String(rule.port);

        return inbound(name, priority, "Allow", rule.proto === Proto.UDP ? "Udp" : "Tcp", rule.from, ports);
    }

    const deny = inbound(DENY.name, DENY.priority, "Deny", "*", "*", "*");

    return {
        /** §11: before the machine: its own group, all inbound denied but the kind's rules; its id. */
        async make(vm: string, kept: Rule[]): Promise<string> {
            await arm.done("PUT", versioned(path.nsg(vm), API.network), {
                location: region,
                tags: { [GROUP]: vm, [MADE]: String(Date.now()) },
                properties: {
                    securityRules: [
                        ...kept.map((rule, index) => {
                            return allow(`rig-${randomBytes(4).toString("hex")}`, 100 + index, rule);
                        }),
                        deny,
                    ],
                },
            });

            return path.nsg(vm);
        },

        async open(vm: string, rule: Rule): Promise<Rule> {
            const nsg = await nsgOf(vm);

            if (!nsg) {
                throw new Error(`azure: ${vm} has no security group of its own`);
            }

            const rules = nsg.properties?.securityRules ?? [];
            const name = `rig-${randomBytes(4).toString("hex")}`;

            const priority =
                1 +
                rules.reduce((top, one) => {
                    const at = one.properties?.priority ?? 0;

                    return at < DENY.priority ? Math.max(top, at) : top;
                }, 99);

            /* The one rule, on its own: the group's other rules and tags stay as they are. */
            await arm.done("PUT", versioned(`${path.nsg(vm)}/securityRules/${name}`, API.network), {
                properties: allow(name, priority, rule).properties,
            });

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
            const rules = ((await nsgOf(vm))?.properties?.securityRules ?? []).filter((one) => {
                return one.name !== DENY.name;
            });

            return rules.map((one) => {
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
                const young = Date.now() - Number(group.tags?.[MADE] ?? 0) < YOUNG;

                if (vm && !young && !(await exists(vm))) {
                    await remove(path.nsg(vm));
                }
            }
        },
    };
}
