import { isArray, isFunction, isObject, isString } from "radash";

import { Guard, Market, Reason, Slot } from "./enums.js";
import { isDur, isPct, isUint, NAME } from "./parse.js";
import { Refusal } from "./refusal.js";
import { checkRule } from "./rules.js";
import type { Provider, RigConfig } from "./types.js";

/** The rig generation this core follows. */
export const RIG = 1;

const ROOT = ["rig", "app", "providers", "kinds", "guard", "every", "poll", "store", "extra"];
const KIND = ["name", "try", "image", "disk", "script", "risk", "life", "recovers", "tags", "ports"];
const ENTRY = ["provider", "market", "types", "image", "extra"];
const RESERVED: Record<string, string[]> = { root: ["hub"], kind: ["node", "save"] };

const MARKETS: string[] = Object.values(Market);

function fail(path: string, message: string): never {
    throw new Refusal(Reason.CONFIG, `${path}: ${message}`);
}

/* Every key of `value` is known; reserved keys and unknown keys are named by path. */
function keys(path: string, value: Record<string, unknown>, known: string[], reserved: string[] = []): void {
    for (const key of Object.keys(value)) {
        if (reserved.includes(key)) {
            fail(`${path}${key}`, "reserved key");
        }

        if (!known.includes(key)) {
            fail(`${path}${key}`, "unknown key");
        }
    }
}

/* The providers as given, or none when they are not a list; §5 refuses that. */
function providersOf(config: RigConfig): Provider[] {
    return isArray(config.providers) ? config.providers : [];
}

/** §4: the config and every plugin are generation 1. */
export function generation(config: RigConfig): void {
    if (config.rig !== RIG) {
        throw new Refusal(Reason.GENERATION, `config is for rig ${String(config.rig)}, this is rig ${RIG}`);
    }

    for (const provider of providersOf(config)) {
        if (provider.rig !== RIG) {
            throw new Refusal(
                Reason.GENERATION,
                `provider ${provider.name} is for rig ${String(provider.rig)}, this is rig ${RIG}`,
            );
        }
    }
}

/* The calls a provider must have, by its `can`. */
function calls(provider: Provider): string[] {
    const can = provider.can ?? {};

    return [
        "places",
        "create",
        "get",
        "list",
        "end",
        "reboot",
        ...(can.stop ? ["start", "stop"] : []),
        ...(can.disk ? ["disk.grow", "disk.get"] : []),
        ...(can.port ? ["port.open", "port.close", "port.list"] : []),
    ];
}

function has(provider: Provider, call: string): boolean {
    const [head, tail] = call.split(".") as [string, string?];
    const value = (provider as unknown as Record<string, unknown>)[head];

    if (tail) {
        return isObject(value) && isFunction((value as Record<string, unknown>)[tail]);
    }

    return isFunction(value);
}

/** §8: every plugin, in order: slot, name, calls. */
export function plugins(config: RigConfig): void {
    const names = new Set<string>();

    for (const provider of providersOf(config)) {
        if ((provider.slot as Slot) === Slot.HUB) {
            fail(`providers[${provider.name}].slot`, "the hub slot is reserved");
        }

        if (provider.slot !== Slot.PROVIDER) {
            throw new Refusal(Reason.PLUGIN, `plugin ${provider.name}: unknown slot ${String(provider.slot)}`);
        }

        if (!NAME.test(provider.name ?? "") || names.has(provider.name)) {
            throw new Refusal(Reason.PLUGIN, `plugin ${provider.name}: name is not a name, or taken`);
        }

        names.add(provider.name);

        for (const optional of ["check", "shape"] as const) {
            if (provider[optional] !== undefined && !isFunction(provider[optional])) {
                throw new Refusal(Reason.PLUGIN, `plugin ${provider.name}: ${optional} is not a call`);
            }
        }

        for (const call of calls(provider)) {
            if (!has(provider, call)) {
                throw new Refusal(Reason.PLUGIN, `plugin ${provider.name}: missing call ${call}`);
            }
        }
    }
}

/** §8.5: each provider's own `check`; a throw is a refusal. */
export async function checks(config: RigConfig): Promise<void> {
    for (const provider of providersOf(config)) {
        if (!provider.check) {
            continue;
        }

        try {
            await provider.check();
        } catch (error) {
            throw new Refusal(Reason.PLUGIN, `plugin ${provider.name}: check failed: ${String(error)}`);
        }
    }
}

/** §5: every key known, of its type; names unique; entries name installed providers. */
export function config(config: RigConfig): void {
    keys("", config as unknown as Record<string, unknown>, ROOT, RESERVED.root);

    if (!isString(config.app) || !NAME.test(config.app)) {
        fail("app", "not a name");
    }

    if (!isArray(config.providers) || config.providers.length === 0) {
        fail("providers", "at least one");
    }

    if (!isArray(config.kinds) || config.kinds.length === 0) {
        fail("kinds", "at least one");
    }

    if (config.guard !== undefined && !Object.values(Guard).includes(config.guard)) {
        fail("guard", "warn or refuse");
    }

    if (config.every !== undefined && !isDur(config.every)) {
        fail("every", "not a dur");
    }

    if (config.poll !== undefined && (!isDur(config.poll) || config.poll === "0")) {
        fail("poll", "not a dur");
    }

    if (config.store !== undefined && !isString(config.store)) {
        fail("store", "not a str");
    }

    if (config.extra !== undefined && !isObject(config.extra)) {
        fail("extra", "not an object");
    }

    const providers = new Map(
        config.providers.map((provider) => {
            return [provider.name, provider];
        }),
    );

    const names = new Set<string>();

    for (const kind of config.kinds) {
        if (!isObject(kind) || !isString(kind.name) || !NAME.test(kind.name)) {
            fail("kinds", "a kind without a name");
        }

        const path = `kinds[${kind.name}].`;

        if (names.has(kind.name)) {
            fail(`${path}name`, "taken");
        }

        names.add(kind.name);
        keys(path, kind, KIND, RESERVED.kind);

        if (kind.image !== undefined && !isString(kind.image)) {
            fail(`${path}image`, "not a str");
        }

        if (kind.disk !== undefined && !isUint(kind.disk)) {
            fail(`${path}disk`, "not a uint");
        }

        if (kind.script !== undefined && !isString(kind.script)) {
            fail(`${path}script`, "not a str");
        }

        if (kind.risk !== undefined) {
            if (!isObject(kind.risk)) {
                fail(`${path}risk`, "not an object");
            }

            keys(`${path}risk.`, kind.risk, ["max"]);

            if (!isPct(kind.risk.max)) {
                fail(`${path}risk.max`, "not a pct");
            }
        }

        if (kind.life !== undefined && !isDur(kind.life)) {
            fail(`${path}life`, "not a dur");
        }

        if (kind.recovers !== undefined && !isUint(kind.recovers)) {
            fail(`${path}recovers`, "not a uint");
        }

        if (kind.tags !== undefined) {
            if (!isObject(kind.tags)) {
                fail(`${path}tags`, "not an object");
            }

            for (const [name, value] of Object.entries(kind.tags)) {
                if (name.startsWith("rig") || !isString(value)) {
                    fail(`${path}tags.${name}`, "a str, under a name that does not start with rig");
                }
            }
        }

        if (kind.ports !== undefined) {
            if (!isArray(kind.ports)) {
                fail(`${path}ports`, "a list of rules");
            }

            kind.ports.forEach((rule, index) => {
                try {
                    checkRule(rule);
                } catch (error) {
                    fail(`${path}ports[${index}]`, (error as Error).message);
                }
            });
        }

        if (!isArray(kind.try) || kind.try.length === 0) {
            fail(`${path}try`, "at least one entry");
        }

        kind.try.forEach((entry, index) => {
            const at = `${path}try[${index}].`;

            if (!isObject(entry)) {
                fail(`${path}try[${index}]`, "not an object");
            }

            keys(at, entry, ENTRY);

            const provider = providers.get(entry.provider);

            if (!provider) {
                fail(`${at}provider`, `${String(entry.provider)} is not installed`);
            }

            const market = entry.market as unknown[];

            if (
                !isArray(market) ||
                market.length === 0 ||
                new Set(market).size !== market.length ||
                !market.every((one) => {
                    return MARKETS.includes(one as string);
                })
            ) {
                fail(`${at}market`, "a list of spot and demand, at least one, no repeats");
            }

            if (kind.ports !== undefined && !provider.can?.port) {
                fail(`${path}ports`, `${provider.name} cannot open ports`);
            }

            if (entry.market.includes(Market.SPOT) && !provider.can?.spot) {
                fail(`${at}market`, `${provider.name} does not sell spot`);
            }

            if (
                !isArray(entry.types) ||
                entry.types.length === 0 ||
                !entry.types.every((type) => {
                    return isString(type);
                })
            ) {
                fail(`${at}types`, "a list of types, at least one");
            }

            if (entry.image !== undefined && !isString(entry.image)) {
                fail(`${at}image`, "not a str");
            }

            if (entry.extra !== undefined && !isObject(entry.extra)) {
                fail(`${at}extra`, "not an object");
            }
        });
    }
}
