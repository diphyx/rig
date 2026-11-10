import { randomBytes } from "node:crypto";

import { Proto, type Rule } from "@diphyx/rig";

import { codeOf, type Gce } from "./gce.js";
import { partsOf } from "./machine.js";

type Firewall = {
    name?: string;
    sourceRanges?: string[];
    allowed?: { IPProtocol?: string; ports?: string[] }[];
};

/** A machine's ports: firewall rules aimed at its own network tag, which is its name. */
export function createPorts(gce: Gce, network: string) {
    const described = (id: string): string => {
        return `rig:${id}`;
    };

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

    return {
        async open(id: string, rule: Rule): Promise<Rule> {
            const project = await gce.project();
            const { name } = partsOf(id);
            const firewall = `${name.slice(0, 54)}-${randomBytes(4).toString("hex")}`;

            const ports =
                rule.to !== undefined && rule.to !== rule.port ? `${rule.port}-${rule.to}` : String(rule.port);

            await gce.wait(
                await gce.call("POST", `projects/${project}/global/firewalls`, {
                    name: firewall,
                    description: described(id),
                    network: `projects/${project}/${network}`,
                    direction: "INGRESS",
                    allowed: [{ IPProtocol: rule.proto ?? Proto.TCP, ports: [ports] }],
                    sourceRanges: [rule.from],
                    targetTags: [name],
                }),
            );

            return { ...rule, id: firewall };
        },

        async close(_id: string, rule: string): Promise<void> {
            await remove(rule);
        },

        async list(id: string): Promise<Rule[]> {
            return (await rules(id)).map((one) => {
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

        /** §11: before `end`: every rule of the machine, deleted, so none outlives it. */
        async release(id: string): Promise<void> {
            for (const one of await rules(id)) {
                await remove(one.name ?? "");
            }
        },
    };
}
