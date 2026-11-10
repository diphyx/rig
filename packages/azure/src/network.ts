import type { Arm } from "./arm.js";
import { API, type Paths, versioned } from "./paths.js";

/** The group and network a machine needs, made once, on first use; a given subnet is used as it is. */
export function createNetwork(arm: Arm, path: Paths, region: string, subnet: string | undefined) {
    let ready: Promise<string> | null = null;

    async function make(): Promise<string> {
        await arm.done("PUT", path.group, { location: region });

        const network = path.network(region);

        await arm.done("PUT", versioned(network, API.network), {
            location: region,
            properties: {
                addressSpace: { addressPrefixes: ["10.42.0.0/16"] },
                subnets: [{ name: "machines", properties: { addressPrefix: "10.42.0.0/20" } }],
            },
        });

        return `${network}/subnets/machines`;
    }

    return {
        /** The subnet's id: the given one, or rig's own, made once. */
        subnet(): Promise<string> {
            if (subnet) {
                return Promise.resolve(subnet);
            }

            ready ??= make();

            ready.catch(() => {
                ready = null;
            });

            return ready;
        },
    };
}
