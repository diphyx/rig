import { isArray, isString, unique } from "radash";

import { Arch, Market, PresetArch, PresetName, Reason } from "./enums.js";
import { Refusal } from "./refusal.js";
import type { Kind } from "./types.js";

/** §12: a provider's preset table: preset → arch → size → types; `small` has no size: arch → types. */
export type PresetTable = Record<string, Record<string, string[] | Record<string, string[]>>>;

/** The kind keys a preset passes on unchanged, §7.2. */
type Pass = Pick<Kind, "distro" | "disk" | "login" | "script" | "risk" | "life" | "recovers" | "tags" | "ports">;

type Common = Pass & {
    name: string;
    /** This provider's image id, booted as it is: the entry's `image`, in place of `distro`. */
    image?: string;
    market?: Market[];
    arch?: PresetArch;
};

type Sized = Common & {
    /** Also try the next `up` sizes, after every type of the asked size. */
    up?: number;
};

export type Presets = {
    /** A light, long-lived box. */
    small(options: Common): Kind;
    /** Balanced cpu and memory. */
    general(options: Sized & { cpu?: number }): Kind;
    /** Cpu-heavy work; spot first. */
    compute(options: Sized & { cpu?: number }): Kind;
    /** Memory-heavy work; `mem` in GB. */
    memory(options: Sized & { mem?: number }): Kind;
    /** Gpu work, by model; spot first. */
    gpu(options: Common & { gpu?: string }): Kind;
};

/* §7.1: each preset's size option, default size and default market; its default disk is `base` GB, and `per` GB for each of the asked size. */
const PRESETS: Record<
    PresetName,
    { size?: "cpu" | "mem" | "gpu"; default?: number; market: Market[]; disk: { base: number; per: number } }
> = {
    [PresetName.SMALL]: { market: [Market.DEMAND], disk: { base: 30, per: 0 } },
    [PresetName.GENERAL]: { size: "cpu", default: 2, market: [Market.DEMAND], disk: { base: 30, per: 5 } },
    [PresetName.COMPUTE]: { size: "cpu", default: 4, market: [Market.SPOT, Market.DEMAND], disk: { base: 30, per: 5 } },
    [PresetName.MEMORY]: { size: "mem", default: 32, market: [Market.DEMAND], disk: { base: 30, per: 0.5 } },
    [PresetName.GPU]: { size: "gpu", market: [Market.SPOT, Market.DEMAND], disk: { base: 200, per: 0 } },
};

/* §7.3: the default disk, from the asked size, up to a multiple of 10 GB: room for the provider's own image, and more. */
function diskOf(preset: PresetName, wanted: unknown): number {
    const { size, default: fallback, disk } = PRESETS[preset];
    const asked = size === "gpu" ? 0 : Number(wanted ?? fallback ?? 0);

    return Math.ceil((disk.base + disk.per * asked) / 10) * 10;
}

const PASS = ["distro", "disk", "login", "script", "risk", "life", "recovers", "tags", "ports"];
const ARCHES = [Arch.ARM, Arch.X86];

function refuse(preset: PresetName, message: string): never {
    throw new Refusal(Reason.CONFIG, `preset ${preset}: ${message}`);
}

/* §7.3: the sizes to try, smallest fit first, then `up` more; for gpu, the model as named. */
function sizesOf(preset: PresetName, sold: Record<string, string[]>, wanted: unknown, up: number): string[] {
    if (preset === PresetName.GPU) {
        const model = (wanted as string | undefined) ?? Object.keys(sold)[0];

        return model !== undefined && sold[model] ? [model] : [];
    }

    const want = Number(wanted ?? PRESETS[preset].default);
    const sizes = Object.keys(sold)
        .map(Number)
        .sort((a, b) => {
            return a - b;
        })
        .filter((size) => {
            return size >= want;
        });

    return sizes.slice(0, 1 + up).map(String);
}

/* One arch's types, one list per size: the asked size first, then `up` more. */
function typesOf(preset: PresetName, table: PresetTable, arch: Arch, wanted: unknown, up: number): string[][] {
    const sold = table[preset]?.[arch];

    if (!sold) {
        return [];
    }

    if (isArray(sold)) {
        return [sold];
    }

    return sizesOf(preset, sold, wanted, up).map((size) => {
        return sold[size] ?? [];
    });
}

/* Size by size, and within a size, arch by arch: no bigger size before every type of a smaller one. */
function interleave(lists: string[][][]): string[] {
    const sizes = Math.max(
        0,
        ...lists.map((one) => {
            return one.length;
        }),
    );

    return Array.from({ length: sizes }, (_, size) => {
        return lists.flatMap((one) => {
            return one[size] ?? [];
        });
    }).flat();
}

/* §7.2: the arches to take, in order. */
function archesOf(preset: PresetName, options: Common, table: PresetTable, wanted: unknown): Arch[] {
    if (options.arch === PresetArch.ANY) {
        if (options.image !== undefined) {
            refuse(preset, "arch any with an image: an image fits one arch");
        }

        return ARCHES;
    }

    if (options.arch) {
        return [options.arch === PresetArch.ARM ? Arch.ARM : Arch.X86];
    }

    if (options.image === undefined) {
        return ARCHES;
    }

    return [typesOf(preset, table, Arch.ARM, wanted, 0).flat().length > 0 ? Arch.ARM : Arch.X86];
}

/** §7: the presets of one provider, from its data file's table; every provider's are made the same way. */
export function createPresets(provider: string, table: PresetTable): Presets {
    function make(preset: PresetName, options: Sized & Record<string, unknown>): Kind {
        const rule = PRESETS[preset];
        const sized = preset !== PresetName.SMALL && preset !== PresetName.GPU;
        const taken = [
            "name",
            "market",
            "arch",
            "image",
            ...PASS,
            ...(rule.size ? [rule.size] : []),
            ...(sized ? ["up"] : []),
        ];

        if (!isString(options.name)) {
            refuse(preset, "a name is required");
        }

        for (const key of Object.keys(options)) {
            if (!taken.includes(key)) {
                refuse(preset, `${key} is not an option of this preset`);
            }
        }

        if (options.image !== undefined && options.distro !== undefined) {
            refuse(preset, "image with distro: the image is booted in place of it");
        }

        const wanted = rule.size ? options[rule.size] : undefined;
        const up = Number(options.up ?? 0);
        const types = unique(
            interleave(
                archesOf(preset, options, table, wanted).map((arch) => {
                    return typesOf(preset, table, arch, wanted, up);
                }),
            ),
        );

        if (types.length === 0) {
            refuse(
                preset,
                `nothing sold for ${rule.size ? `${rule.size} ${String(wanted ?? rule.default ?? "")}` : "it"}`,
            );
        }

        const pass = Object.fromEntries(
            PASS.filter((key) => {
                return options[key] !== undefined;
            }).map((key) => {
                return [key, options[key]];
            }),
        );

        return {
            ...(options.image === undefined && { disk: diskOf(preset, wanted) }),
            ...pass,
            name: options.name,
            try: [
                {
                    provider,
                    market: options.market ?? [...rule.market],
                    types,
                    ...(options.image !== undefined && { image: options.image }),
                },
            ],
        };
    }

    return {
        small(options) {
            return make(PresetName.SMALL, options);
        },
        general(options) {
            return make(PresetName.GENERAL, options);
        },
        compute(options) {
            return make(PresetName.COMPUTE, options);
        },
        memory(options) {
            return make(PresetName.MEMORY, options);
        },
        gpu(options) {
            return make(PresetName.GPU, options);
        },
    };
}
