import { type Arch, Distro } from "./enums.js";
import type { KindDistro, Provider, SpecDistro } from "./types.js";

/** §6.1: each distro's major versions, newest first, its default version, and its login user. */
export const DISTROS: Record<Distro, { versions: string[]; default: string; user: string }> = {
    [Distro.UBUNTU]: { versions: ["24.04", "22.04"], default: "24.04", user: "ubuntu" },
    [Distro.DEBIAN]: { versions: ["13", "12"], default: "12", user: "debian" },
};

/** §6.1: a kind's distro, `ubuntu` when it has none, with its version filled in. */
export function distroOf(distro: KindDistro | undefined): SpecDistro {
    const name = distro?.name ?? Distro.UBUNTU;

    return { name, version: distro?.version ?? DISTROS[name].default };
}

/** §12: a provider's distro table: distro → version → arch → its pointer, in the provider's own form. */
export type DistroTable<T> = Partial<Record<Distro, Record<string, Record<Arch, T>>>>;

/** §8, §12: a provider's distro table, read: the versions it offers, and the pointer for a distro on an arch. */
export function createDistroTable<T>(provider: string, table: DistroTable<T>) {
    const offers = Object.fromEntries(
        Object.entries(table).map(([distro, versions]) => {
            return [distro, Object.keys(versions)];
        }),
    ) as Provider["distros"];

    return {
        offers,

        /** The pointer to the newest image of `distro` for `arch`; the core only asks for what `offers` names. */
        pointerOf(distro: SpecDistro, arch: Arch): T {
            const pointer = table[distro.name]?.[distro.version]?.[arch];

            if (pointer === undefined) {
                throw new Error(`${provider}: no ${distro.name} ${distro.version} image for ${arch}`);
            }

            return pointer;
        },
    };
}
