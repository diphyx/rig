/* Reaching a machine: this machine's IP, the SSH key, a command over SSH, the first boot. */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sleep } from "radash";

import { fail } from "./log.ts";
import { APP } from "./clouds.ts";

const execute = promisify(execFile);

const KEY = join(dirname(fileURLToPath(import.meta.url)), "..", ".keys", "id_ed25519");

/* Waits between SSH tries, for a machine still booting. */
const TRIES = { every: 10_000, tries: 30 };

/* SSH's arguments to a machine: the key, no host-key store, a short connect. */
function argsOf(user: string, ip: string, command: string): string[] {
    return [
        "-i",
        KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "LogLevel=ERROR",
        `${user}@${ip}`,
        command,
    ];
}

/** The SSH public key every machine logs in with, made at the first call, kept in `test/e2e/.keys`. */
export function sshKey(): string {
    if (!existsSync(KEY)) {
        mkdirSync(dirname(KEY), { recursive: true });
        execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", APP, "-f", KEY], { stdio: "ignore" });
    }

    return readFileSync(`${KEY}.pub`, "utf8").trim();
}

/** The public IP of the machine the run is on, the one SSH leaves from: the only one its machines' port 22 lets in. */
export function myIp(): string {
    return execFileSync("curl", ["-fsS", "--noproxy", "*", "https://checkip.amazonaws.com"], {
        encoding: "utf8",
    }).trim();
}

/** A command on the machine over SSH, tried until it answers; its output. Other stages run on meanwhile. */
export async function ssh(user: string, ip: string, command: string): Promise<string> {
    for (let tries = 1; ; tries += 1) {
        try {
            return (await execute("ssh", argsOf(user, ip, command))).stdout;
        } catch {
            if (tries === TRIES.tries) {
                fail(`ssh ${user}@${ip}: no answer after ${TRIES.tries} tries`);
            }

            await sleep(TRIES.every);
        }
    }
}

/** A command on the machine over SSH, once, its output streamed here, `input` its stdin; its exit code. */
export function sshStream(user: string, ip: string, command: string, input?: Buffer): number {
    return (
        spawnSync("ssh", argsOf(user, ip, command), {
            input,
            stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
        }).status ?? 1
    );
}

/** The machine's first boot, once it is done (spec §6.2): its exit code and its log's end. */
export async function bootOf(user: string, ip: string): Promise<{ exit: string; log: string }> {
    const answer = await ssh(
        user,
        ip,
        /* /var/lib/rig is root's only: its files, seen by sudo. */
        "for i in $(seq 60); do sudo test -f /var/lib/rig/boot.exit && break; sleep 5; done; " +
            "echo EXIT=$(sudo cat /var/lib/rig/boot.exit); sudo tail -n 20 /var/log/rig/boot.log",
    );

    return { exit: /EXIT=(\S*)/.exec(answer)?.[1] ?? "", log: answer };
}
