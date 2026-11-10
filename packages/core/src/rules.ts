import { isIP } from "node:net";

import { isObject, isString } from "radash";

import { From, Proto, Reason } from "./enums.js";
import { isUint } from "./parse.js";
import { Refusal } from "./refusal.js";
import type { Match, Rule } from "./types.js";

const LAST = 65_535;
const MATCH = ["port", "to", "proto", "from"];

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

/* §10: a `from` as CIDRs: `any` is both, IPv4 first. */
function fromsOf(from: string): string[] {
    return from === From.ANY ? [From.ANY4, From.ANY6] : [from];
}

/* §20: each field given is one: ports in range, `to` not below `port`, a proto, a CIDR or `any`. */
function checkFields(fields: Match): void {
    if (fields.port !== undefined && !isPort(fields.port)) {
        refuse(`port ${String(fields.port)} is not from 1 to ${LAST}`);
    }

    if (fields.to !== undefined && (!isPort(fields.to) || fields.to < (fields.port ?? 1))) {
        refuse(`to ${String(fields.to)} is not from port to ${LAST}`);
    }

    if (fields.proto !== undefined && !Object.values(Proto).includes(fields.proto)) {
        refuse(`proto ${String(fields.proto)} is not tcp or udp`);
    }

    if (fields.from !== undefined && fields.from !== From.ANY && !isCidr(fields.from)) {
        refuse(`from ${String(fields.from)} is not a CIDR, or any`);
    }
}

/** §20: a rule that is one: a `port` and a `from`, each field as `checkFields` reads it; or a refusal naming the field. */
export function checkRule(rule: Rule): void {
    if (!isObject(rule) || rule.port === undefined || rule.from === undefined) {
        refuse("a rule needs port and from");
    }

    checkFields(rule);
}

/** §20: a checked rule, as the provider takes it: `from: any` as two rules, IPv4 then IPv6. */
export function expandRule(rule: Rule): Rule[] {
    checkRule(rule);

    return fromsOf(rule.from).map((from) => {
        return { ...rule, from };
    });
}

/** §20: two rules are equal on `port`, `to`, `proto` and `from`; an absent `to` is `port`, an absent `proto` is `tcp`. */
export function sameRule(a: Rule, b: Rule): boolean {
    return (
        a.port === b.port &&
        (a.to ?? a.port) === (b.to ?? b.port) &&
        (a.proto ?? Proto.TCP) === (b.proto ?? Proto.TCP) &&
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
        refuse("a match needs port, to, proto or from");
    }

    for (const key of keys) {
        if (!MATCH.includes(key)) {
            refuse(`${key} is not a match key`);
        }
    }

    checkFields(match);
}

/** §20: the rule has every key the match gives; `from: any` is either IPv4's or IPv6's anywhere. */
export function matchesRule(rule: Rule, match: Match): boolean {
    return (
        (match.port === undefined || rule.port === match.port) &&
        (match.to === undefined || (rule.to ?? rule.port) === match.to) &&
        (match.proto === undefined || (rule.proto ?? Proto.TCP) === match.proto) &&
        (match.from === undefined || fromsOf(match.from).includes(rule.from))
    );
}
