/** Azure Resource Manager paths and API versions, in one place. */
export const API = {
    resources: "2021-04-01",
    subscriptions: "2022-12-01",
    compute: "2024-07-01",
    disks: "2024-03-02",
    network: "2024-05-01",
    skus: "2021-07-01",
};

export function paths(subscription: string, group: string) {
    const sub = `/subscriptions/${subscription}`;
    const rg = `${sub}/resourceGroups/${group}`;

    return {
        subscription: `${sub}?api-version=${API.subscriptions}`,
        group: `${sub}/resourcegroups/${group}?api-version=${API.resources}`,
        skus: (region: string) => {
            return `${sub}/providers/Microsoft.Compute/skus?api-version=${API.skus}&$filter=${encodeURIComponent(`location eq '${region}'`)}`;
        },
        network: (region: string) => {
            return `${rg}/providers/Microsoft.Network/virtualNetworks/rig-${region}`;
        },
        vm: (name: string) => {
            return `${rg}/providers/Microsoft.Compute/virtualMachines/${name}`;
        },
        vms: `${rg}/providers/Microsoft.Compute/virtualMachines?api-version=${API.compute}&statusOnly=true`,
        nsgs: `${rg}/providers/Microsoft.Network/networkSecurityGroups?api-version=${API.network}`,
        nsg: (name: string) => {
            return `${rg}/providers/Microsoft.Network/networkSecurityGroups/${name}-nsg`;
        },
    };
}

export type Paths = ReturnType<typeof paths>;

/** A resource id or path, with its API version. */
export function versioned(id: string, version: string): string {
    return `${id}${id.includes("?") ? "&" : "?"}api-version=${version}`;
}
