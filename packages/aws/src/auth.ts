import { Reason, Refusal } from "@diphyx/rig";

/** Spec §8.1: the three ways a rig provider signs in. */
export enum AuthFrom {
    AUTO = "auto",
    ENV = "env",
    KEYS = "keys",
}

/** Spec §8.1: how the provider signs in; the same three ways on every rig provider. */
export type Auth =
    { from: AuthFrom.AUTO } | { from: AuthFrom.ENV; prefix?: string } | { from: AuthFrom.KEYS; keys: Keys };

/** The keys aws takes. */
export type Keys = { id: string; secret: string; token?: string };

/** The key names, for §8.1; `?` marks an optional one. */
export const KEYS = ["id", "secret", "token?"];

/* `aws-east` → `AWS_EAST`. */
function upper(name: string): string {
    return name.toUpperCase().replaceAll("-", "_");
}

function refuse(provider: string, message: string): never {
    throw new Refusal(Reason.PLUGIN, `provider ${provider}: auth ${message}`);
}

/** §8.1: the keys from `auth`; `null` for `auto`: the AWS SDK's own chain. A refusal names the key. */
export function resolveAuth(
    provider: string,
    auth: Auth = { from: AuthFrom.AUTO },
    env: Record<string, string | undefined> = process.env,
): Keys | null {
    if (auth.from === AuthFrom.AUTO) {
        return null;
    }

    const names = KEYS.map((name) => {
        return { key: name.replace(/\?$/, ""), optional: name.endsWith("?") };
    });

    let given: Record<string, string | undefined>;

    if (auth.from === AuthFrom.ENV) {
        const prefix = auth.prefix ?? `RIG_${upper(provider)}`;

        given = Object.fromEntries(
            names.map(({ key }) => {
                return [key, env[`${prefix}_${upper(key)}`]];
            }),
        );
    } else if (auth.from === AuthFrom.KEYS) {
        given = auth.keys;

        for (const key of Object.keys(given)) {
            if (
                !names.some((one) => {
                    return one.key === key;
                })
            ) {
                refuse(provider, `has a key aws does not take: ${key}`);
            }
        }
    } else {
        refuse(provider, `from ${String((auth as { from: unknown }).from)} is not a way: auto, env or keys`);
    }

    const keys: Record<string, string> = {};

    for (const { key, optional } of names) {
        const value = given[key];

        if (value === undefined || value === "") {
            if (!optional) {
                refuse(provider, `from ${auth.from} is missing ${key}`);
            }

            continue;
        }

        keys[key] = value;
    }

    return keys as Keys;
}
