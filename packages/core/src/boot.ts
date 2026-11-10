import { isObject, isString } from "radash";

import { distroOf, DISTROS } from "./distro.js";
import { Reason } from "./enums.js";
import { base64Of, isStrings, NAME } from "./parse.js";
import { Refusal } from "./refusal.js";
import type { Kind } from "./types.js";

/* An SSH public key, one line: its type, its base64, and a comment if it has one. */
const KEY =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\n]*)?$/;

/* The most the smallest startup script of the official clouds holds: aws's user data. */
const MOST = 16 * 1024;

function refuse(path: string, message: string): never {
    throw new Refusal(Reason.CONFIG, `${path}: ${message}`);
}

/** §6.1, §6.2: the kind's login user: its own, or its distro's; none without a `login`. */
export function userOf(kind: Kind): string | undefined {
    return kind.login ? (kind.login.user ?? DISTROS[distroOf(kind.distro).name].user) : undefined;
}

/** §6.2: the first-boot script from the kind's `login`, its worker's lines (§22.2) and `script`: once, as root, logged; none without any. */
export function buildBoot(kind: Kind, worker?: string[]): string | undefined {
    if (!kind.login && !worker && kind.script === undefined) {
        return undefined;
    }

    const user = userOf(kind);

    return `${[
        "#!/bin/bash",
        "# rig: the kind's first boot, once, as root",
        "[ -e /var/lib/rig/boot.ran ] && exit 0",
        "mkdir -p /var/lib/rig /var/log/rig",
        "chmod 700 /var/lib/rig /var/log/rig",
        "touch /var/lib/rig/boot.ran",
        "exec >>/var/log/rig/boot.log 2>&1",
        "trap 'echo $? > /var/lib/rig/boot.exit' EXIT",
        "set -eo pipefail",
        ...(kind.login
            ? [
                  `id -u ${user} >/dev/null 2>&1 || useradd -m -s /bin/bash ${user}`,
                  `[ "$(id -u ${user})" -ge 1000 ] || { echo "rig: ${user} is a system user" >&2; exit 1; }`,
                  `home=$(getent passwd ${user} | cut -d: -f6)`,
                  'mkdir -p "$home/.ssh"',
                  `echo '${base64Of(kind.login.keys)}' | base64 -d >> "$home/.ssh/authorized_keys"`,
                  'chmod 700 "$home/.ssh"',
                  'chmod 600 "$home/.ssh/authorized_keys"',
                  `chown -R ${user}: "$home/.ssh"`,
                  `echo '${user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/rig-login`,
                  "chmod 440 /etc/sudoers.d/rig-login",
              ]
            : []),
        ...(worker ?? []),
        ...(kind.script !== undefined
            ? [
                  `echo '${base64Of(kind.script)}' | base64 -d > /var/lib/rig/script`,
                  "chmod 700 /var/lib/rig/script",
                  "if head -n 1 /var/lib/rig/script | grep -q '^#!'; then /var/lib/rig/script; else bash /var/lib/rig/script; fi",
              ]
            : []),
    ].join("\n")}\n`;
}

/** §5, §6.2: a kind's `login` and `script` are each one, and its first-boot script fits; else a refusal naming the key. */
export function checkBoot(path: string, kind: Kind, worker?: string[]): void {
    const { login, script } = kind as { login?: unknown; script?: unknown };

    if (login !== undefined) {
        if (!isObject(login)) {
            refuse(`${path}login`, "not an object");
        }

        for (const key of Object.keys(login)) {
            if (!["user", "keys"].includes(key)) {
                refuse(`${path}login.${key}`, "unknown key");
            }
        }

        const { user, keys } = login as { user?: unknown; keys?: unknown };

        if (user !== undefined && (!isString(user) || !NAME.test(user) || user === "root")) {
            refuse(`${path}login.user`, "a name, not root");
        }

        if (!isStrings(keys) || keys.length === 0) {
            refuse(`${path}login.keys`, "at least one SSH public key");
        }

        for (const key of keys) {
            if (!KEY.test(key)) {
                refuse(`${path}login.keys`, `${key.slice(0, 24)}... is not an SSH public key`);
            }
        }
    }

    if (script !== undefined && !isString(script) && !isStrings(script)) {
        refuse(`${path}script`, "not a str, or a list of lines");
    }

    const size = Buffer.byteLength(buildBoot(kind, worker) ?? "");

    if (size > MOST) {
        refuse(`${path}script`, `a first-boot script of ${size} bytes, above ${MOST}`);
    }
}
