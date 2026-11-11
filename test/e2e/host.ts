/* The e2e host: one small AWS machine made by rig, the e2e run on it. `pnpm test:e2e [stage...]`, start to end; or one step: `pnpm test:e2e up|push|run <stage>...|down`. */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tryit } from "radash";

import { createRig, Distro, Status, type Machine } from "@diphyx/rig";

import { fail, log, ok } from "./lib/log.ts";
import { makeProvider } from "./lib/clouds.ts";
import { bootOf, ssh, sshKey, sshStream } from "./lib/ssh.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE = join(ROOT, "test", "e2e", ".host");

/* Its name: `rig-e2e-host-<id>`; an app of its own, so `sweep` leaves it. */
const APP = "rig";
const KIND = "e2e-host";

/* The host's first boot: Node 24 and pnpm. */
const SCRIPT = [
    "ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')",
    'NODE=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o "node-v24[^\\"]*-linux-$ARCH.tar.xz" | head -1)',
    'curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE" | tar -xJ -C /usr/local --strip-components=1',
    "npm i -g pnpm",
];

const aws = makeProvider("aws");
const rig = createRig({
    rig: 1,
    app: APP,
    providers: [aws],
    kinds: [
        aws.presets.small({
            name: KIND,
            distro: { name: Distro.UBUNTU },
            disk: 30,
            login: { keys: [sshKey()] },
            script: SCRIPT,
            ports: [{ port: 22, from: "0.0.0.0/0" }],
            life: "6h",
        }),
    ],
    every: "0",
    store: STORE,
});

/* The host the store holds, if any. */
async function heldOf(): Promise<Machine | undefined> {
    return (await rig.machine.list())[0];
}

/* The host the store holds. */
async function hostOf(): Promise<Machine> {
    return (await heldOf()) ?? fail("no host: run up first");
}

/* A command on the host, its output streamed here; a nonzero exit fails the action. */
function onHost(host: Machine, command: string, input?: Buffer): void {
    const exit = sshStream(host.user!, host.ip!.public!, command, input);

    if (exit !== 0) {
        fail(`on the host: ${command}: exit ${exit}`);
    }
}

const ACTIONS: Record<string, (rest: string[]) => Promise<void>> = {
    /* The host made, or the one the store holds, running and booted. */
    up: async () => {
        const made = (await heldOf()) ?? (await rig.machine.create(KIND)) ?? fail("no room for the host");
        const host = await rig.machine.wait(made.id, Status.RUNNING);
        const boot = await bootOf(host.user!, host.ip!.public!);

        log(boot.log);
        ok(boot.exit === "0", `${host.name}: ${host.id}, ${host.type} in ${host.zone}, at ${host.ip!.public}`);
        log((await ssh(host.user!, host.ip!.public!, "echo node $(node -v), pnpm $(pnpm -v)")).trim());
    },

    /* The repo's files, git's tracked and new ones, and test/e2e/.env; then its packages installed. */
    push: async () => {
        const host = await hostOf();
        const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
        const packed = execFileSync("tar", ["--no-xattrs", "-cz", "-T", "-", "test/e2e/.env"], {
            cwd: ROOT,
            input: files,
            /* No extended attributes, no macOS ._ files: GNU tar on the host warns on both. */
            env: { ...process.env, COPYFILE_DISABLE: "1" },
        });

        onHost(host, "rm -rf rig && mkdir rig && tar -xz -C rig && chmod 600 rig/test/e2e/.env", packed);
        log(`pushed ${packed.length} bytes`);
        onHost(host, "cd rig && CI=true pnpm install --frozen-lockfile");
    },

    /* The stages, run on the host. */
    run: async (stages) => {
        onHost(await hostOf(), `cd rig && pnpm test:e2e:run ${stages.join(" ")}`);
    },

    /* The host ended. */
    down: async () => {
        const host = await hostOf();

        await rig.machine.end(host.id);
        log(`ended ${host.name}: ${host.id}`);
    },

    /* Start to end: the host up, the files pushed, the stages run, `all` by default; the host ended after, pass or fail. */
    test: async (stages) => {
        const [error] = await tryit(async () => {
            await ACTIONS.up!([]);
            await ACTIONS.push!([]);
            await ACTIONS.run!(stages.length > 0 ? stages : ["all"]);
        })();

        /* A host that never came up has nothing to end. */
        if (await heldOf()) {
            await ACTIONS.down!([]);
        }

        if (error) {
            throw error;
        }
    },
};

/* An action's name first, or stages only: start to end with them. */
const asked = process.argv.slice(2);
const [action, ...rest] = ACTIONS[asked[0] ?? ""] ? asked : ["test", ...asked];

await rig.open();

const [error] = await tryit(ACTIONS[action!]!)(rest);

await rig.close();

if (error) {
    fail(error.message);
}
