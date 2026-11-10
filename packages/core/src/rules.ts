import { isIP } from "node:net";

import { isObject, isString } from "radash";

import { From, Protocol, Reason } from "./enums.js";
import { isUint } from "./parse.js";
import { Refusal } from "./refusal.js";
import type { Match, Rule } from "./types.js";

const LAST = 65_535;
const MATCH = ["port", "to", "protocol", "from"];
const RULE = ["id", ...MATCH];

function refuse(message: string): never {
    throw new Refusal(Reason.CONFIG, `rule: ${message}`);
}

/* An IPv4 or IPv6 CIDR: `1.2.3.4/32`, `::/0`. */
function isCidr(value: unknown): boolean {
    if (!isString(value)) {
        return false;
    }

    const [address = "", bits = "", ...rest] = value.split("/");
    const version = isIP(address);
    const size = Number(bits);

    return rest.length === 0 && version !== 0 && /^\d+$/.test(bits) && size <= (version === 4 ? 32 : 128);
}

function isPort(value: unknown): boolean {
    return isUint(value) && value >= 1 && value <= LAST;
}

/* Anywhere, on each IP version. */
const ANYWHERE = ["0.0.0.0/0", "::/0"];

/* §10: a `from` as CIDRs, by its value: `any` is anywhere on IPv4 then IPv6; an IP is itself, `/32` or `/128`. */
function fromsOf(from: string): string[] {
    if (from === From.ANY) {
        return ANYWHERE;
    }

    const version = isIP(from);

    return [version === 0 ? from : `${from}/${version === 4 ? 32 : 128}`];
}

/* A `from` that is one: `any`, an IP, or a CIDR. */
function isFrom(value: unknown): boolean {
    return value === From.ANY || (isString(value) && isIP(value) !== 0) || isCidr(value);
}

/* §20: each field given is one: ports in range, `to` not below `port`, a protocol, an IP, a CIDR or `any`. */
function checkFields(fields: Match): void {
    if (fields.port !== undefined && !isPort(fields.port)) {
        refuse(`port ${String(fields.port)} is not from 1 to ${LAST}`);
    }

    if (fields.to !== undefined && (!isPort(fields.to) || fields.to < (fields.port ?? 1))) {
        refuse(`to ${String(fields.to)} is not from port to ${LAST}`);
    }

    if (fields.protocol !== undefined && !Object.values(Protocol).includes(fields.protocol)) {
        refuse(`protocol ${String(fields.protocol)} is not tcp or udp`);
    }

    if (fields.from !== undefined && !isFrom(fields.from)) {
        refuse(`from ${String(fields.from)} is not an IP, a CIDR, or any`);
    }
}

/** §20: a rule that is one: a `port` and a `from`, each field as `checkFields` reads it; or a refusal naming the field. */
export function checkRule(rule: Rule): void {
    if (!isObject(rule) || rule.port === undefined || rule.from === undefined) {
        refuse("a rule needs port and from");
    }

    for (const key of Object.keys(rule)) {
        if (!RULE.includes(key)) {
            refuse(`${key} is not a rule key`);
        }
    }

    checkFields(rule);
}

/** §20: a checked rule, as the provider takes it: its `from` as a CIDR, `any` as two rules, IPv4 then IPv6. */
export function expandRule(rule: Rule): Rule[] {
    checkRule(rule);

    return fromsOf(rule.from).map((from) => {
        return { ...rule, from };
    });
}

/** §20: two rules are equal on `port`, `to`, `protocol` and `from`; an absent `to` is `port`, an absent `protocol` is `tcp`. */
export function sameRule(a: Rule, b: Rule): boolean {
    return (
        a.port === b.port &&
        (a.to ?? a.port) === (b.to ?? b.port) &&
        (a.protocol ?? Protocol.TCP) === (b.protocol ?? Protocol.TCP) &&
        a.from === b.from
    );
}

/** §20: a match with at least one key, each a rule's; or a refusal naming the field. */
export function checkMatch(match: Match): void {
    const keys = isObject(match)
        ? Object.keys(match).filter((key) => {
              return (match as Record<string, unknown>)[key] !== undefined;
          })
        : [];

    if (keys.length === 0) {
        refuse("a match needs port, to, protocol or from");
    }

    for (const key of keys) {
        if (!MATCH.includes(key)) {
            refuse(`${key} is not a match key`);
        }
    }

    checkFields(match);
}

/** §20: the rule has every key the match gives; `from: any` is anywhere on either IP version; an IP is its own `/32` or `/128`. */
export function matchesRule(rule: Rule, match: Match): boolean {
    return (
        (match.port === undefined || rule.port === match.port) &&
        (match.to === undefined || (rule.to ?? rule.port) === match.to) &&
        (match.protocol === undefined || (rule.protocol ?? Protocol.TCP) === match.protocol) &&
        (match.from === undefined ||
            fromsOf(match.from).some((from) => {
                return fromsOf(rule.from).includes(from);
            }))
    );
}
