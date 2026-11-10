import { isIP } from "node:net";

import { isString } from "radash";

import { Proto, Reason } from "./enums.js";
import { isUint } from "./parse.js";
import { Refusal } from "./refusal.js";
import type { Rule } from "./types.js";

const LAST = 65_535;

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

/** §20: a rule that is one: ports in range, `to` not below `port`, a `Proto`, a CIDR; or a refusal naming the field. */
export function checkRule(rule: Rule): void {
    if (!isUint(rule.port) || rule.port < 1 || rule.port > LAST) {
        refuse(`port ${String(rule.port)} is not from 1 to ${LAST}`);
    }

    if (rule.to !== undefined && (!isUint(rule.to) || rule.to < rule.port || rule.to > LAST)) {
        refuse(`to ${String(rule.to)} is not from port to ${LAST}`);
    }

    if (rule.proto !== undefined && !Object.values(Proto).includes(rule.proto)) {
        refuse(`proto ${String(rule.proto)} is not tcp or udp`);
    }

    if (!isCidr(rule.from)) {
        refuse(`from ${String(rule.from)} is not a CIDR`);
    }
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
