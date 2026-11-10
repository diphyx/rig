# @diphyx/rig-grid

The **grid** worker for [rig](../core): it runs jobs on rig's machines, over [grid](https://github.com/diphyx/grid) (`grid/2`). In grid's words, the app runs the **hub**, in TypeScript, and each machine runs grid's own **node**, set up at its first boot.

**Status: draft.** Checked against grid's own vectors, and against a real `grid node`.

Its machines are **job machines**: short-lived, often spot, replaced at will. A machine's cmds are fixed at its create, like its type: to change them, change the kind, and new machines get them.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-grid
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";
import { createGrid } from "@diphyx/rig-grid";

const aws = createAws(); // its region: AWS_REGION, else us-east-1

const grid = createGrid(); // its IP found, its key made, its grid release built in

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    workers: [grid],
    kinds: [
        aws.presets.compute({
            name: "builder",
            life: "8h", // job machines are short-lived
            worker: { tags: ["build"], cmds: { make: { exec: ["make", "-j8"], timeout: "1h" } } },
        }),
    ],
});

await rig.open();
await rig.machine.create("builder"); // its node joins the hub once the machine has an IP

const outcome = await grid.run({
    tag: "build",
    push: [{ from: "./src", to: "src" }],
    steps: [{ cmd: "make" }],
    pull: [{ path: "out", into: "./out" }],
    retries: 2,
});
```

## Config

Every option has a default: `createGrid()` is a whole hub.

| Option       | Default                                                                            | Is                                                                                        |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ip`         | found when rig opens: the app host's public IP, or its own with `reach: "private"` | the hub's IP, as the machines see it: they accept the hub only from it                    |
| `identity`   | `./.rig/grid/hub.key`, made on first use (`0600`), kept after                      | the hub's private key: a path to its file (`grid key new`), or the key itself, base64     |
| `release`    | `RELEASE`: grid `2.0.0`, with its archives' SHA-256                                | the grid release nodes install: `version`, and each arch's archive's `sha256`             |
| `name`       | `"grid"`                                                                           | its name in rig's `workers`                                                               |
| `port`       | `9420`                                                                             | the port nodes listen on                                                                  |
| `listen`     | none                                                                               | the port it listens on for nodes with `signal`; without it, no kind's worker has `signal` |
| `reach`      | `"public"`                                                                         | which IPs it uses: the machines' it dials, and its own it gives them                      |
| `extra.tars` | the temp dir                                                                       | where pushes are packed                                                                   |
| `extra.log`  | none                                                                               | where its lines go: a node that stops answering, a job that ends or waits                 |

- **Keys:** the hub's own is made once and kept, so its machines keep trusting it across restarts; keep `identity` safe and backed up. Each machine's own key pair is made at its create: nothing to set.
- **Release:** the default is the one this package was checked against; give `release` to pin another, its `sha256`s from that release's `checksums.txt`.
- **IP:** behind NAT, or on a private network, give `ip`, or set `reach: "private"` when the hub and its machines share a network.

## A Kind's Worker

| Key      | Is                                                                                      |
| -------- | --------------------------------------------------------------------------------------- |
| `tags`   | the kinds of work the node does: a job runs only on a node with its tag                 |
| `cmds`   | the only cmds it runs: grid's `[cmds.<name>]`, `exec` and `timeout`; at least one       |
| `signal` | grid's `signal`: the node also dials the hub, with heartbeats; needs the hub's `listen` |

## A Machine's First Boot

At its create, each machine gets its own grid key pair, and these first-boot lines, after its `login` and before its `script`:

1. **grid installed:** the release's archive for the machine's arch, checked by its SHA-256, its binary owned by root.
2. **its user:** a system user, `grid`, that the node runs as.
3. **its keys:** the machine's private key in `/etc/grid/node.key`, the hub's public key in `/etc/grid/hub.pub`.
4. **`/etc/grid/node.toml`:** its tags, its cmds, its port, and the hub, by IP; with `signal`, the hub's `listen` port too.
5. **a systemd unit,** `grid-node`, started.

It also gets the hub's port, open to the hub's IP only. The private key is in the machine's first-boot script, which the cloud keeps as its user data: anything that can read the machine's metadata can read it, and the hub trusts it only from that machine's IP. rig's store keeps the public half only.

## Jobs

`grid.run(job, options)` places a job on a node with its tag and runs it there:

| Job key   | Is                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `tag`     | which nodes may run it: a node `tags` it                                                               |
| `push`    | `{ from, to, isShared? }`: files sent into the job's space; a share is kept on the node for later jobs |
| `steps`   | `{ cmd, args?, env? }`: the node's cmds, in order; the first that fails ends the job                   |
| `pull`    | `{ path, into, isSinceStart?, isKept? }`: files brought back                                           |
| `retries` | how many times a lost node's job starts over elsewhere; `0`                                            |

`options` has `signal` (an `AbortSignal` that kills it), `onEvent` (its log lines and events), `onStep` (more steps after one ends done), and `onPlaced` (where it runs, for `grid.recover` after a restart).

- **A machine is lost:** rig replaces it, up to its kind's `recovers`; the job starts over on any free node with its tag, up to its `retries`, the replacement too.
- **No node comes:** when rig stops replacing a kind's machines, it tells the hub (`spent`), and a job no node can take fails.
- **A job keeps its own work:** a take-back may come with little warning, or none. Save progress in the job's own steps, and resume from there.
- **New cmds:** a new tag for them (`build-v2`) keeps jobs off machines made with the old ones.

`grid.nodes()` lists every node: its machine's name, IP and tags, whether it beats, and whether it is lost.

## Signal

With a kind's `worker.signal` and the hub's `listen`, each node also dials the hub, with heartbeats: a node is lost after 15 s without one, sooner than after 30 s of failing calls. Open `listen` to the machines. (A job's `signal` option is something else: an `AbortSignal` that stops it.)

## Spec

The worker follows [rig generation 1](../../spec/SPEC.md), §22, and speaks [grid/2](https://github.com/diphyx/grid).
