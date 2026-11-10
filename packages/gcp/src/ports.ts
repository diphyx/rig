import { randomBytes } from "node:crypto";

import { Proto, type Rule } from "@diphyx/rig";
import { tryit } from "radash";

import { codeOf, type Gce } from "./gce.js";
import { partsOf } from "./machine.js";

type Firewall = {
    name?: string;
    sourceRanges?: string[];
    allowed?: { IPProtocol?: string; ports?: string[] }[];
    denied?: unknown[];
};

/* Allow rules rank above the machine's deny-all, which ranks above the network's own (65534). */
const ALLOW = 900;
const DENY = 1000;

/* The machine's deny-all: one rule per IP version, by its name's suffix. */
const DENIES = [
    { suffix: "deny4", range: "0.0.0.0/0" },
    { suffix: "deny6", range: "::/0" },
];

/* A rule's name: the machine's, cut to leave room for a suffix, keeping its random end so no two machines share one. */
function baseOf(id: string): string {
    const { name } = partsOf(id);

    return name.length <= 54 ? name : `${name.slice(0, 45)}${name.slice(-9)}`;
}

/** A machine's ports: firewall rules aimed at its own network tag, which is its name; all inbound denied but those. */
export function createPorts(gce: Gce, network: string) {
    /* Every rule of the machine is described by its id, to be found by it. */
    function described(id: string): string {
        return `rig:${id}`;
    }

    async function rules(id: string): Promise<Firewall[]> {
        const project = await gce.project();
        const filter = encodeURIComponent(`description = "${described(id)}"`);

        return (await gce.all<Firewall>(`projects/${project}/global/firewalls?filter=${filter}`, "items")).map(
            (one) => {
                return one.item;
            },
        );
    }

    async function remove(name: string): Promise<void> {
        const project = await gce.project();

        try {
            await gce.wait(await gce.call("DELETE", `projects/${project}/global/firewalls/${name}`));
        } catch (error) {
            if (codeOf(error) !== "notFound") {
                throw error;
            }
        }
    }

    /* One firewall rule for the machine, aimed at its tag. */
    async function insert(id: string, name: string, body: Record<string, unknown>): Promise<void> {
        const project = await gce.project();

        await gce.wait(
            await gce.call("POST", `projects/${project}/global/firewalls`, {
                name,
                description: described(id),
                network: `projects/${project}/${network}`,
                direction: "INGRESS",
                targetTags: [partsOf(id).name],
                ...body,
            }),
        );
    }

    async function open(id: string, rule: Rule): Promise<Rule> {
        const firewall = `${baseOf(id)}-${randomBytes(4).toString("hex")}`;
        const ports = rule.to !== undefined && rule.to !== rule.port ? `${rule.port}-${rule.to}` : String(rule.port);

        await insert(id, firewall, {
            priority: ALLOW,
            allowed: [{ IPProtocol: rule.proto ?? Proto.TCP, ports: [ports] }],
            sourceRanges: [rule.from],
        });

        return { ...rule, id: firewall };
    }

    /* Every rule of the machine, deleted, so none outlives it. */
    async function release(id: string): Promise<void> {
        for (const one of await rules(id)) {
            await remove(one.name ?? "");
        }
    }

    return {
        open,
        release,

        /** §11: before the machine: all inbound denied, IPv4 and IPv6, but the kind's rules; a failed one leaves nothing. */
        async make(id: string, kept: Rule[]): Promise<void> {
            try {
                for (const { suffix, range } of DENIES) {
                    await insert(id, `${baseOf(id)}-${suffix}`, {
                        priority: DENY,
                        denied: [{ IPProtocol: "all" }],
                        sourceRanges: [range],
                    });
                }

                for (const rule of kept) {
                    await open(id, rule);
                }
            } catch (error) {
                await tryit(release)(id);

                throw error;
            }
        },

        async close(_id: string, rule: string): Promise<void> {
            await remove(rule);
        },

        async list(id: string): Promise<Rule[]> {
            const allowed = (await rules(id)).filter((one) => {
                return one.allowed !== undefined;
            });

            return allowed.map((one) => {
                const [from = "", to] = (one.allowed?.[0]?.ports?.[0] ?? "0").split("-");

                return {
                    id: one.name ?? "",
                    port: Number(from),
                    ...(to !== undefined && { to: Number(to) }),
                    proto: one.allowed?.[0]?.IPProtocol === Proto.UDP ? Proto.UDP : Proto.TCP,
                    from: one.sourceRanges?.[0] ?? "",
                };
            });
        },
    };
}
