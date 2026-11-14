# @diphyx/rig-grid

The **grid** worker for [RIG](../core): it runs jobs on RIG's machines, over [grid](https://github.com/diphyx/grid) (`grid/2`). In grid's words, the app runs the **hub**, in TypeScript, and each machine runs grid's own **node**, set up at its first boot.

Its machines are **job machines**: short-lived, often spot, replaced at will. A machine's cmds are fixed at its create, like its type: to change them, change the kind, and new machines get them.

**Setup guide: [grid](https://diphyx.github.io/rig/#/grid)**

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-grid
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";
import { createGrid } from "@diphyx/rig-grid";

const aws = createAws(); // its region: RIG_AWS_REGION, AWS_REGION, else us-east-1

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
            worker: {
                tags: ["build"],
                cmds: {
                    make: { exec: ["make", "-j8"], timeout: "1h" },
                },
            },
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
| `ip`         | found when RIG opens: the app host's public IP, or its own with `reach: "private"` | the hub's IP, as the machines see it: they accept the hub only from it                    |
| `identity`   | `./.rig/grid/hub.key`, made on first use (`0600`), kept after                      | the hub's private key: a path to its file (`grid key new`), or the key itself, base64     |
| `release`    | `RELEASE`: grid `2.0.0`, with its archives' SHA-256                                | the grid release nodes install: `version`, and each arch's archive's `sha256`             |
| `name`       | `"grid"`                                                                           | its name in RIG's `workers`                                                               |
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

One kind, cmds per machine: `rig.machine.create(kind, { worker })` gives one machine its own `tags` and `cmds`, over the kind's.

```ts
await rig.machine.create("builder", {
    worker: {
        tags: ["req-42"],
        cmds: {
            train: { exec: ["python", "train.py"], timeout: "4h" },
        },
    },
});

await grid.run({ tag: "req-42", steps: [{ cmd: "train" }] });
```

## A Machine's First Boot

At its create, each machine gets its own grid key pair, and these first-boot lines, after its `login`:

1. **grid installed:** the release's archive for the machine's arch, checked by its SHA-256, its binary owned by root.
2. **its user:** a system user, `grid`, that the node runs as.
3. **its keys:** the machine's private key in `/etc/grid/node.key`, the hub's public key in `/etc/grid/hub.pub`.
4. **`/etc/grid/node.toml`:** its tags, its cmds, its port, and the hub, by IP; with `signal`, the hub's `listen` port too.
5. **a systemd unit,** `grid-node`.
6. **the node started,** after its `script`: no job comes before what the `script` sets up; a failed `script` leaves it off.

It also gets its node's `port`, open to the hub's IP only. The private key is in the machine's first-boot script, which the cloud keeps as its user data: anything that can read the machine's metadata can read it, and the hub trusts it only from that machine's IP. RIG's store keeps the public half only.

## Jobs

`grid.run(job, options)` places a job on a node with its tag and runs it there:

| Job key   | Is                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`    | the app's own name for it, unique among live jobs: a request's id; by default `job-<8 hex>`                       |
| `tag`     | which nodes may run it: a node `tags` it                                                                          |
| `push`    | `{ from, to, share? }`: files sent into the job's space; a share is kept on the node for later jobs               |
| `steps`   | `{ cmd, args?, env? }`: the node's cmds, in order; the first that fails ends the job                              |
| `pull`    | `{ path, into, fresh?, keep? }`: files brought back; `fresh`: only what its steps wrote; `keep`: after a kill too |
| `retries` | how many times a lost node's job starts over elsewhere; `0`                                                       |

`options` has `signal` (an `AbortSignal` that kills it), `watch` (its log lines and events), `next` (more steps after one ends done), and `placed` (where it runs, for `grid.recover` after a restart).

- **A machine is lost:** RIG replaces it, up to its kind's `recovers`; the job starts over on any free node with its tag, up to its `retries`, the replacement too.
- **No node comes:** when RIG stops replacing a kind's machines, it tells the hub (`spent`), and a job no node can take fails.
- **A job keeps its own work:** a take-back may come with little warning, or none. Save progress in the job's own steps, and resume from there.
- **New cmds:** a new tag for them (`build-v2`) keeps jobs off machines made with the old ones; or give them to one machine at its create.

## Sessions

`grid.session(options)` opens a job on a node with its tag, for the app's own calls, one at a time; it waits for a node with room, as a job does:

```ts
const job = await grid.session({ tag: "req-42", name: "req-42" });

await job.push({ from: "./tools", to: "tools", share: true }); // kept on the node for later jobs
await job.push({ from: "./inputs", to: "." });

// { cmd, state, message }, once the step ends
const step = await job.exec({
    cmd: "train",
    args: ["--epochs", "3"],
    env: { SEED: "1" },
});

await job.pull({ path: "out", into: "./results", fresh: true });

// the node drops it, its slot is free: done, failed or stopped
const outcome = await job.close();
```

| Option   | Is                                                                      |
| -------- | ----------------------------------------------------------------------- |
| `tag`    | which nodes may take it                                                 |
| `name`   | the app's own name for it, as a job's                                   |
| `share`  | its pushes have a share: a node with its share on is tried first        |
| `signal` | an `AbortSignal` that kills it: while it waits, or the step it runs     |
| `watch`  | its node's log lines and events, from its first                         |
| `placed` | where it runs, once a node takes it: for `grid.recover` after a restart |

- **Its calls:** `push`, `exec` and `pull` take what a job's `push`, `steps` and `pull` do, shares too, checked the same way; `exec` waits for the step's end. `steps`, `pushed` and `files` keep what each gave.
- **Its outcome:** `close` gives it as `run` does: `stopped` by a kill, `failed` when a step did not end done, else `done`.
- **A kill:** its signal or `grid.kill(name)` stops the step it runs; then only `pull`, for what it kept, and `close`.
- **No retries:** a lost node fails the call; the app opens another session.

## Views

Each takes a filter: those with every key given.

| Call                                    | Gives                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `grid.jobs({ tag?, state?, node? })`    | its live jobs: `name`, `tag`, `state` (`waiting`, `running`), `node`, `step`, `tries`, `started` |
| `grid.job(name)`                        | one live job; `null` once it ends                                                                |
| `grid.nodes({ tag?, beating?, lost? })` | its nodes: the machine's `name`, `ip`, `tags`, `beating`, `lost`, and the `jobs` it runs         |

| Call                        | Does                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `grid.kill(name)`           | stops a live job, or a session; `false` when none has the name              |
| `grid.watch(name, handler)` | a live job's log lines and events from now on; the call it gives stops them |
| `grid.on(JobEvent.*, ...)`  | its jobs: `PLACED` on a node, `RETRIED` after a lost one, `ENDED`           |

- **In memory:** the hub's own, so after a restart `grid.jobs()` is empty; `placed` and `grid.recover` take back what ran.
- **A node is its machine:** `node` and `nodes()`'s `name` are RIG's machine names, as `rig.machine.list({ tag })` gives them.

## Signal

With a kind's `worker.signal` and the hub's `listen`, each node also dials the hub, with heartbeats: a node is lost after 15 s without one, sooner than after 30 s of failing calls. Open `listen` to the machines. (A job's `signal` option is something else: an `AbortSignal` that stops it.)

## Spec

The worker follows [RIG generation 1](../../spec/SPEC.md), §22, and speaks [grid/2](https://github.com/diphyx/grid).
