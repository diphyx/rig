import { isArray, isString } from "radash";

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const DUR = /^(\d+)(s|m|h|d)$/;
const PCT = /^(\d+(?:\.\d+)?)%$/;

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function isDur(value: unknown): value is string {
    return value === "0" || (isString(value) && DUR.test(value));
}

/** A `dur` in ms; `"0"`, or any zero, is never. */
export function dur(value: string): number {
    const match = DUR.exec(value);
    const ms = match ? Number(match[1]) * UNITS[match[2] as keyof typeof UNITS] : 0;

    return ms === 0 ? Infinity : ms;
}

export function isPct(value: unknown): value is string {
    return isString(value) && PCT.test(value);
}

export function pct(value: string): number {
    return Number(PCT.exec(value)?.[1]);
}

export function isUint(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

/** A list of strs. */
export function isStrings(value: unknown): value is string[] {
    return (
        isArray(value) &&
        value.every((one) => {
            return isString(one);
        })
    );
}

/** §6.2, §22.2: a text, as base64 on one line: a `str` as it is, or lines joined by `\n`, with one more at the end. */
export function base64Of(text: string | string[]): string {
    return Buffer.from(isString(text) ? text : `${text.join("\n")}\n`).toString("base64");
}
