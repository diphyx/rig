# Agents

> Single-file, end-to-end reference for AI coding agents setting up or using rig. Reading this once gives the full model: core, providers, kinds, presets, failover, risk, rounds, workers, grid, calls, events, refusals, and the kit.

- **Name:** rig, short for Remote Instance Gateway
- **Packages:** `@diphyx/rig` (the core), `@diphyx/rig-aws`, `@diphyx/rig-gcp`, `@diphyx/rig-azure` (providers), `@diphyx/rig-grid` (the grid worker); TypeScript, ESM, Node.js
- **Install:** `pnpm add @diphyx/rig @diphyx/rig-aws`; the core and at least one provider
- **Spec:** `rig/1`, exact in `spec/SPEC.md`; the kit, as data, in `spec/kit/`
- **Linux only:** Ubuntu or Debian, or a Linux image of your own; first boot is a bash script, login is SSH
- **Versions:** the major is the generation (`docs/versions.md`): `rig: 1` in the config; the store under `<store>/rig/1/`; machines tagged `rig: 1`; nothing of another generation is read or touched

---

## 1. Mental Model

rig creates Linux machines on cloud providers with failover. A **kind** is a named recipe: its `try` list says where its machines may go, in order; its other keys say what each machine is. `machine.create(kind)` tries the kind's **places** (provider, market, type, zone) in order, one `create` each, and stops at the first that has room. Each round, the core lists its machines: one the cloud took back is **lost**, and the core **recovers** it with a new failover.

```
app → core → provider.create(place) → busy → next place → ... → machine
        │
        └── rounds: list → lost → recover; old → end; found → adopt
```

| Term        | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| core        | the library inside the app: failover, risk, recover, guard                |
| provider    | a plugin for one cloud; makes machines, one try per call                  |
| worker      | a plugin that runs jobs on machines: grid                                 |
| kind        | a named recipe for machines                                               |
| entry       | one item of a kind's `try`: a provider, markets, types                    |
| place       | a provider, market, type and zone                                         |
| try         | one `create` at one place                                                 |
| busy        | a try's answer when there is no room: `zone`, `type`, `market`, `account` |
| market      | `spot` (the cloud may take it back) or `demand`                           |
| take-back   | the cloud ending a spot machine on its own                                |
| lost        | a machine that ended without the core ending it                           |
| recover     | a failover that replaces a lost machine                                   |
| risk        | the core's estimate of a place's take-backs, percent a month              |
| job machine | a machine of a kind with a `worker`: short-lived, made to run jobs        |

Machine verbs: create, start, stop, reboot, end. Core verbs: open, close; neither touches a machine.

## 2. Config

```ts
import { createRig, Distro, Guard } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws();

const rig = createRig({
    rig: 1, // required: the generation
    app: "my-app", // required: a name; tags every machine
    providers: [aws], // at least one
    kinds: [aws.presets.compute({ name: "worker" })], // at least one
    guard: Guard.WARN, // or Guard.REFUSE
    every: "30s", // between rounds; "0": only rig.round()
    poll: "5s", // between polls of a wait; not "0"
    store: "./.rig", // the core uses <store>/rig/1/
});
```

- **Names:** `[a-z][a-z0-9-]{0,31}`: `app`, kind names, provider names, worker tags.
- **Durations:** strings, a number and `s`, `m`, `h` or `d`: `"30s"`, `"8h"`; any zero means never.
- **Refusals:** a config that is not right refuses at `open`, naming the key by path: `kinds[worker].try[0].types: a list of types, at least one`.
- **Unknown keys** are refusals; a lib's own settings go in `extra`.

## 3. Kind

```ts
{
    name: "worker",
    try: [
        { provider: "aws", market: [Market.SPOT, Market.DEMAND], types: ["c8g.2xlarge", "c7g.2xlarge"] },
        { provider: "gcp", market: [Market.DEMAND], types: ["c4a-standard-8"] },
    ],
    distro: { name: Distro.UBUNTU, version: "24.04" },
    disk: 100,
    login: {
        keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGm5nRrnDrU0H8wXkVhQvTq1aXj4Q0bQ0aQ0bQ0aQ0bQ me@laptop"],
    },
    script: ["apt-get update", "apt-get install -y nginx"],
    ports: [{ port: 443, from: From.ANY }],
    risk: { max: "10%" },
    life: "8h",
    recovers: 3,
    tags: { team: "ml" },
}
```

| Key        | Default        | Is                                                                           |
| ---------- | -------------- | ---------------------------------------------------------------------------- |
| `name`     | —              | unique among kinds                                                           |
| `try`      | —              | entries, in failover order; at least one                                     |
| `distro`   | Ubuntu `24.04` | `UBUNTU` `24.04`, `22.04`; `DEBIAN` `13`, `12` (default `12`)                |
| `disk`     | the provider's | GB of the boot disk, from `30`                                               |
| `login`    | none           | `{ user?, keys }`: SSH keys; `user` defaults to `ubuntu` or `debian`; `sudo` |
| `script`   | none           | a str, or its lines; runs once, as root, at first boot                       |
| `ports`    | none           | the only inbound rules open; all else closed, inside its network too         |
| `worker`   | none           | its machines run jobs for a worker                                           |
| `risk`     | none           | `{ max: pct }`: places above it are not tried                                |
| `life`     | never          | the core ends each machine after this                                        |
| `recovers` | `3`            | replacements along a lost machine's chain; `0` = none                        |
| `tags`     | none           | the app's own; no key starts with `rig`                                      |

| Entry key  | Is                                                                             |
| ---------- | ------------------------------------------------------------------------------ |
| `provider` | a provider's `name`                                                            |
| `market`   | always a list, in order, no repeats: `[Market.DEMAND]`                         |
| `types`    | the provider's type names, best first                                          |
| `image`    | the provider's Linux image id, booted in place of `distro`; needs `login.user` |
| `extra`    | the provider's own create options                                              |

**First boot:** one bash script the core builds: a guard (runs once), the `login` part, the worker's lines, the `script`. Output to `/var/log/rig/boot.log`, exit code to `/var/lib/rig/boot.exit`; at most 16 KB; a failed first boot is not run again.

**Distro:** the provider boots the version's newest image for the type's arch, found at each create; a region without it is `busy type`.

## 4. Presets

Every provider has the same five; only `name` is required:

| Preset    | Size option | Default size | Default market   | Default disk (GB) |
| --------- | ----------- | ------------ | ---------------- | ----------------- |
| `small`   | —           | —            | `demand`         | `30`              |
| `general` | `cpu`       | `2`          | `demand`         | `30 + 5 × cpu`    |
| `compute` | `cpu`       | `4`          | `spot`, `demand` | `30 + 5 × cpu`    |
| `memory`  | `mem` (GB)  | `32`         | `demand`         | `30 + mem / 2`    |
| `gpu`     | `gpu`       | the cheapest | `spot`, `demand` | `200`             |

Options: `cpu`, `mem`, `gpu` (rounded up to the next size sold), `arch` (`PresetArch.ANY`: arm's types, then x86's; `ARM`; `X86`), `up` (the next `up` sizes too), `market`, `image` (one arch, not `ANY`), `disk`, and any kind key. A disk is rounded up to a multiple of 10. An option a preset does not take is a refusal. A preset never calls the cloud.

## 5. Failover

```
for entry in kind.try:
    places = provider.places(entry), above kind.risk.max removed
    for market in entry.market:
        for type in entry.types:
            for place of this market and type, sorted by zone:
                ok           → the machine
                busy zone    → next zone
                busy type    → next type, also in the entry's other markets
                busy market  → next market
                busy account → next entry; on spot, next market
                throw        → to the app
null
```

- No place is tried twice in one failover; an entry's `places` is called only when failover reaches it.
- `Event.TRY` after every try: `{ kind, place, answer }`; a throw is `answer: { error }`.

## 6. Risk

`takeback`, percent a month, per place `<provider>/<market>/<type>/<zone>`:

```
prior    = 0 on demand; on spot: min(50, base × size × arch)
           base 25 with a gpu, 5 with ≤ 2 vCPU, else 8
           size 1 ≤ 4 vCPU, 1.25 ≤ 16, 1.5 ≤ 48, else 2
           arch 0.8 on arm, else 1
pressure = busy ÷ (tries + 5)
months   = (hours + running machines' hours so far) ÷ 730
p        = min(50, prior × (1 + pressure)) ÷ 100
takeback = 100 × (lost + p × 2) ÷ (months + 2), one decimal
```

Counts (`tries`, `busy`, `created`, `lost`, `hours`) are kept in `<store>/rig/1/risk.json`. A machine the core ends is never counted lost.

## 7. Rounds, Recover, Guard

**Open**, in order: generation; plugins; workers; each provider's `check`; each worker's `open`; config; the store; guard; the first round. **Close:** stops rounds, ends nothing.

| Seen in a round                                  | The core                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| in the store, now ended or gone, not by the core | lost: count, `end` (cleans up), `MACHINE_LOST`, recover                |
| in the store, ended by the core                  | out of the store                                                       |
| in the store, past its kind's `life`             | end, `MACHINE_ENDED`                                                   |
| not in the store, its kind in the config         | adopt it; a job machine is ended: `MACHINE_ENDED`, `reason: Why.FOUND` |
| not in the store, its kind not in the config     | `MACHINE_ORPHAN`, never ended                                          |

**Recover:** a failover from the kind's first entry, with the lost machine's create options. `ok` → `MACHINE_RECOVERED`; `null` → again next round; `recovers` spent → `MACHINE_FAILED`.

**Guard** (at open, once per kind and code, a refusal with `Guard.REFUSE`): `SPOT_WARN` (any spot), `SPOT_LONG` (spot, no `life`, a spot place above 10%), `SPOT_NARROW` (spot, fewer than 3 spot places).

## 8. Calls

| Call                                         | Does                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `open()`, `close()`, `round()`               | begin rounds; end them; a round now                                              |
| `on(event, handler)`                         | hears an event; may come before `open`                                           |
| `place.list(kind)`                           | the places a failover would try, in order, each with `provider` and `risk`       |
| `machine.create(kind, { worker? })`          | a failover; `null` with no room; `worker` over the kind's, for this machine      |
| `machine.get(id)`                            | the provider's view, into the store; `null` for an id it does not hold           |
| `machine.wait(id, status, timeout?)`         | polls until `status`, or `ended`; `timeout` default `"10m"`                      |
| `machine.list({ kind?, status?, tag? })`     | from the store; `tag`: a worker's tag                                            |
| `machine.lost({ kind? })`                    | lost machines still waiting for their replacement                                |
| `machine.end`, `start`, `stop`, `reboot`     | the provider's; `stop` on spot is a refusal                                      |
| `disk.grow(id, gb)`, `disk.get`, `disk.wait` | the boot disk; it only grows                                                     |
| `port.open(id, rule)`                        | rules opened; `from: From.ANY` is two; an equal rule is given back               |
| `port.close(id, idOrMatch)`                  | by a rule's id, or every rule a match (`port`, `to`, `protocol`, `from`) matches |
| `port.list(id)`                              | the machine's rules                                                              |

A machine the app sees: the provider's `id`, `status`, `market`, `type`, `zone`, `image`, `tags`, `ip`, `created`, plus `provider`, `kind`, `name`, `user` (with `login`), `worker: { name, key, tags, ip }` (with a `worker`).

## 9. Events and Refusals

| `Event`             | Data                      |
| ------------------- | ------------------------- |
| `TRY`               | `{ kind, place, answer }` |
| `MACHINE_CREATED`   | `{ machine }`             |
| `MACHINE_ENDED`     | `{ machine, reason? }`    |
| `MACHINE_LOST`      | `{ machine }`             |
| `MACHINE_RECOVERED` | `{ lost, machine }`       |
| `MACHINE_FAILED`    | `{ machine, recovers }`   |
| `MACHINE_ORPHAN`    | `{ machine }`             |
| `GUARD`             | `{ kind, code }`          |

A `Refusal` has `reason` and `message`; code reads only `reason`:

| `Reason`      | When                                        |
| ------------- | ------------------------------------------- |
| `GENERATION`  | the config or a plugin is not `rig: 1`      |
| `PLUGIN`      | a plugin is not one, or its `check` throws  |
| `CONFIG`      | the config, a preset, or a call's input     |
| `GUARD`       | a guard finding with `Guard.REFUSE`         |
| `UNSUPPORTED` | a call the provider's `can` does not enable |
| `UNKNOWN`     | a machine id the store does not hold        |
| `CLOSED`      | a call before `open` or after `close`       |
| `TIMEOUT`     | a wait past its `timeout`                   |

## 10. Providers

```ts
createAws({ region: "us-east-1", name: "aws", auth: { from: AuthFrom.AUTO }, identity, extra });
```

| Provider | Region default                                                       | Auth keys (`AuthFrom.ENV`: `RIG_<NAME>_<KEY>`) | Ports                          |
| -------- | -------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| aws      | `AWS_REGION`, `AWS_DEFAULT_REGION`, else `us-east-1`                 | `id`, `secret`, `token?`                       | its own security group         |
| gcp      | `CLOUDSDK_COMPUTE_REGION`, `GOOGLE_CLOUD_REGION`, else `us-central1` | `key` (service account JSON)                   | firewall rules at its tag      |
| azure    | `AZURE_LOCATION`, `AZURE_REGION`, else `eastus`                      | `tenant`, `id`, `secret`                       | its own network security group |

- `auth`: `{ from: AuthFrom.AUTO }` (the default: env, CLI login, machine identity), `{ from: AuthFrom.ENV, prefix? }`, `{ from: AuthFrom.KEYS, keys }`.
- Two regions are two providers, with two names.
- A provider's own keys go in `extra`; any other key is a refusal.
- `can`: `spot`, `stop`, `disk`, `port`; a call it does not enable is `UNSUPPORTED`.

## 11. Workers and grid

```ts
import { createGrid, JobEvent } from "@diphyx/rig-grid";

const grid = createGrid(); // ip found, key made at ./.rig/grid/hub.key, release built in

createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    workers: [grid],
    kinds: [
        aws.presets.compute({
            name: "builder",
            life: "8h",
            worker: {
                tags: ["build"],
                cmds: {
                    make: { exec: ["make", "-j8"], timeout: "1h" },
                },
                signal: false,
            },
        }),
    ],
});
```

- **Job machines:** a kind's `worker` is fixed at each machine's create, like its type. One machine's own: `rig.machine.create(kind, { worker: { tags, cmds } })`, kept for its recovers; give it its own tag.
- **Lifecycle:** at create, `setup` gives the machine's first-boot lines (grid installed, a `grid` user, its keys, `node.toml`, a systemd unit) and its node's port, open to the hub's IP only. Once it has an IP, the core `add`s it to the worker; when it is gone, `drop`s it; when recovers are spent, `spent(tags)`.
- **Jobs:** `grid.run({ name?, tag, push?, steps, pull?, retries? }, { signal?, watch?, next?, placed? })` → `{ name, state: "done" | "failed" | "stopped", message, node, steps, pushed, files }`. Push `{ from, to?, share? }`; step `{ cmd, args?, env? }`; pull `{ path, into, fresh?, keep? }`.
- **Sessions:** `grid.session({ tag, name?, share?, signal?, watch?, placed? })` → `push`, `exec`, `pull`, `close()` (the outcome). No retries; after a kill, only `pull` and `close`.
- **Views:** `grid.jobs({ tag?, state?, node? })`, `grid.job(name)`, `grid.nodes({ tag?, beating?, lost? })`, `grid.kill(name)`, `grid.watch(name, handler)`, `grid.on(JobEvent.PLACED | RETRIED | ENDED, handler)`.
- **Lost:** rig replaces the machine (`recovers`); grid reruns the job from the start on any node with its tag (`retries`). A job keeps its own work: save progress in its own steps.

## 12. Kit

`spec/kit/*.json` are cases, as data: a runner plays each against a core with fake providers and fake workers, and matches results, events, the store and the fakes. `packages/core/test/kit.test.ts` runs them; `pnpm run check` runs types, lint, format, tests and the kit. A core that passes every case may say it follows rig generation 1.

## 13. Common Mistakes

- A `market` that is not a list: `market: Market.SPOT` is refused; write `[Market.SPOT]`.
- An entry's own `image` on a kind with `login`, but no `login.user`: the core cannot know the image's user.
- `ports` on a kind whose provider cannot open them (`can.port` false): refused at open.
- Expecting `stop` on spot: a spot machine cannot be stopped, only ended.
- Reading `machine.ip` right after `create`: it comes once the machine runs; use what `machine.wait` gives.
- A per-machine `worker` with cmds of its own but the kind's tag: jobs for the kind may land on it.
- Losing `./.rig`: the core finds its machines again by tag, but a job machine whose key is gone is ended.
- `signal` on a kind's worker without `createGrid({ listen })`: refused at open.
