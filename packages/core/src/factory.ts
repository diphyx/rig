import { isObject, isString } from "radash";

import { Reason } from "./enums.js";
import { Refusal } from "./refusal.js";
import type { Tags } from "./types.js";

/** §8.2: the keys every provider factory takes. */
export const FACTORY_KEYS = ["region", "name", "auth", "identity", "extra"];

/**
 * §8.2: a provider factory's config: a key outside the standard ones is a refusal, and so is one outside
 * the provider's own `extra` keys; a `region` given is a str.
 */
export function checkFactory(cloud: string, config: object, extra: string[]): void {
    const given = config as Record<string, unknown>;

    const unknown = (keys: string[], known: string[], at: string): void => {
        for (const key of keys) {
            if (!known.includes(key)) {
                throw new Refusal(
                    Reason.CONFIG,
                    `${cloud}: unknown key ${at}${key}${at === "" ? `; ${cloud}'s own go in extra` : ""}`,
                );
            }
        }
    };

    unknown(Object.keys(given), FACTORY_KEYS, "");
    unknown(Object.keys(isObject(given.extra) ? given.extra : {}), extra, "extra.");

    if (given.region !== undefined && (!isString(given.region) || given.region === "")) {
        throw new Refusal(Reason.CONFIG, `${cloud}: region is not a region`);
    }
}

/**
 * §8.2: a factory's region: the one given, else `RIG_<NAME>_REGION`'s with the provider's `name`, else the cloud's
 * own env var's, else the cloud's default region.
 */
export function regionOf(given: string | undefined, env: string[], fallback: string, name?: string): string {
    const own = name === undefined ? [] : [`RIG_${name.toUpperCase().replaceAll("-", "_")}_REGION`];

    return (
        given ??
        [...own, ...env]
            .map((name) => {
                return process.env[name];
            })
            .find((value) => {
                return isString(value) && value !== "";
            }) ??
        fallback
    );
}

/** §12: a provider's tag renames, both ways, so the core only sees its own names. */
export function createTagMap(table: Record<string, string>) {
    const back = Object.fromEntries(
        Object.entries(table).map(([rig, own]) => {
            return [own, rig];
        }),
    );

    const rename = (tags: Tags, names: Record<string, string>): Tags => {
        return Object.fromEntries(
            Object.entries(tags).map(([name, value]) => {
                return [names[name] ?? name, value];
            }),
        );
    };

    return {
        /** rig's names onto the provider's. */
        to(tags: Tags): Tags {
            return rename(tags, table);
        },

        /** the provider's names back onto rig's. */
        from(tags: Tags): Tags {
            return rename(tags, back);
        },
    };
}
