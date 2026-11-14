# grid

> Set up the grid worker, `@diphyx/rig-grid`: where its hub runs, the IP its machines trust, its ports and key, and a first job

The grid worker runs jobs on RIG's machines over [grid](https://github.com/diphyx/grid): the app runs grid's **hub**, in TypeScript, and each job machine runs grid's own **node**, set up at its first boot. What jobs and sessions are: [Worker](worker.md). Its package: [`@diphyx/rig-grid`](https://github.com/diphyx/rig/tree/HEAD/packages/grid).

```bash
pnpm add @diphyx/rig @diphyx/rig-aws @diphyx/rig-grid
```

## 1. How They Reach Each Other

```
        the app's host                              a job machine
 ┌──────────────────────────┐                ┌──────────────────────────┐
 │ rig + its hub            │ ── :9420 ────▶ │ grid node                │
 │   ip: the IP it dials    │                │   lets in the hub's IP   │
 │   from                   │ ◀── :listen ── │   only                   │
 └──────────────────────────┘   with signal  └──────────────────────────┘
```

- **The hub dials each node**, on its `port`, `9420` by default. The provider opens that port on each job machine, to the hub's `ip` only, `/32`.
- **With `signal`,** each node also dials the hub, on its `listen` port, with a heartbeat every 5 s.
- **Each side knows the other's key:** the hub's public key is in each node's config; each node's is in the hub's book. A connection is a Noise handshake: no other hub, and no other node, gets in.

## 2. Where the Hub Runs

The hub runs in the app, on the app's host. What that host needs:

| Needs                                                | Why                                      |
| ---------------------------------------------------- | ---------------------------------------- |
| one public IP it dials out from, the same every time | each node lets in that IP only           |
| to reach the machines' public IPs, on `port`         | the hub dials them                       |
| `listen` open to the machines, with `signal`         | the nodes dial it                        |
| a folder kept across restarts, for its key           | its machines trust that key, and only it |

The hub finds its IP when RIG opens, from `checkip.amazonaws.com`. When the IP the host dials from is another one, give it as `ip`:

| The app's host                                 | Its `ip`                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| a machine in the cloud, with its own public IP | found: nothing to set                                                        |
| behind a NAT with one public IP                | found, or the NAT's IP                                                       |
| a laptop, a VPN, or a network whose IP changes | a host in the cloud instead: the IP machines see can differ by where it goes |
| in the machines' own network                   | `reach: "private"`: the hub dials their private IPs, and gives its own       |

```ts
const grid = createGrid({ ip: "203.0.113.10" }); // the IP the machines see
```

## 3. Its Key

The hub's private key is `identity`: `./.rig/grid/hub.key` by default, made on first use with mode `0600`. Each machine is made trusting the key's public half, so a new key is a new hub to them: keep the file across restarts, and back it up.

```ts
const grid = createGrid({ identity: "/etc/my-app/hub.key" }); // a file
const other = createGrid({ identity: process.env.HUB_KEY }); // or the key itself, base64
```

Each machine's own key pair is made at its create: its private half goes in its first-boot script, its public half in RIG's store.

## 4. Its Ports

| Port     | On               | Opened by                                              | From                  |
| -------- | ---------------- | ------------------------------------------------------ | --------------------- |
| `port`   | each job machine | the provider, at the create, beside the kind's `ports` | the hub's `ip`, `/32` |
| `listen` | the app's host   | you: its firewall, or its security group in the cloud  | the job machines      |

`listen` is only for `signal`. With it, a node is lost after 15 s with no heartbeat; without it, after 30 s of calls that fail.

```ts
const grid = createGrid({ listen: 9421 });

aws.presets.small({
    name: "worker",
    worker: { tags: ["build"], cmds: { make: { exec: ["make"] } }, signal: true },
});
```

## 5. Its Release

Each node installs grid's release for its arch at its first boot, its archive checked by its SHA-256. The default is the release this package was checked against; to pin another, give its `version` and each arch's `sha256`, from that release's `checksums.txt`:

```ts
const grid = createGrid({
    release: { version: "2.0.0", sha256: { arm: "<sha256>", x86: "<sha256>" } },
});
```

The machines download it from GitHub: they need the internet at their first boot.

## 6. A First Job

One kind of job machines, one cmd, one job: a file in, the cmd over it, the result back.

```ts
import { createRig } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";
import { createGrid } from "@diphyx/rig-grid";

const aws = createAws();
const grid = createGrid();

const rig = createRig({
    rig: 1,
    app: "try-grid",
    providers: [aws],
    workers: [grid],
    kinds: [
        aws.presets.small({
            name: "job",
            life: "1h",
            worker: {
                tags: ["note"],
                cmds: { note: { exec: ["sh", "-c", "mkdir -p out && cat in/note.txt > out/note.txt"] } },
            },
        }),
    ],
});

await rig.open();
await rig.machine.create("job");

// waits for its node: the machine's boot, grid installed, its node started
const outcome = await grid.run(
    {
        tag: "note",
        push: [{ from: "./in", to: "in" }],
        steps: [{ cmd: "note" }],
        pull: [{ path: "out", into: "./out" }],
    },
    { signal: AbortSignal.timeout(10 * 60_000) },
);

console.log(outcome.state); // "done"
```

A job waits for a node with its tag and room, as long as it takes: give it a `signal` to stop waiting.

## 7. When It Goes Wrong

| You see                                               | It is                                                               | Do                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| a job that waits, and `node ... does not answer`      | the node is booting, or out of the hub's reach                      | a minute or two at first; then the machine's first boot, below |
| `does not answer` long after the boot                 | the node lets in an IP other than the hub's                         | the hub's `ip`: the IP it dials from, as the machine sees it   |
| a job that waits: `no build node has room`            | every node with its tag runs as many jobs as its `jobs.limit`       | more machines, or a bigger `jobs.limit` on the kind            |
| a node with `signal`, silent                          | the hub's `listen` port is closed to the machines                   | open it on the app's host, or its security group               |
| a refusal at `open`: `no public IP found for the hub` | `checkip.amazonaws.com` was out of reach                            | give `ip`                                                      |
| a job that fails: `push: sha256 differs, 3 times`     | its files changed on the way, each time                             | the network between the hub and the node                       |
| a refusal naming a kind's `worker` key                | a key outside grid's own: `tags`, `cmds`, `signal`, `jobs`, `share` | the kind's `worker`                                            |

On a machine, over SSH: its first boot, then its node:

```bash
sudo cat /var/lib/rig/boot.exit        # 0 once its first boot is done
sudo tail -n 50 /var/log/rig/boot.log   # grid installed, its config written
sudo systemctl status grid-node
sudo cat /etc/grid/node.toml            # its tags, its cmds, the hub it trusts, by IP
```

All of grid's options, its views and events: its [README](https://github.com/diphyx/rig/tree/HEAD/packages/grid).
