# @diphyx/rig

The rig core: create Linux machines on any cloud, with failover.

**Status: draft.** Passes the kit.

> [!IMPORTANT]
> **Linux only.** Every machine rig creates runs Linux: Ubuntu or Debian, or a Linux image of your own. Its first boot is a bash script, and its login is SSH.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

The core and at least one provider: [aws](../aws), [gcp](../gcp), [azure](../azure), or your own.

## Quick Start

```ts
import { createRig, Distro, Event, Status } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws({ region: "us-east-1" });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    kinds: [
        aws.presets.compute({
            name: "worker",
            cpu: 8,
            distro: { name: Distro.DEBIAN },
            login: { keys: ["ssh-ed25519 AAAA... me@laptop"] },
            ports: [{ port: 22, from: "1.2.3.4/32" }],
        }),
    ],
});

rig.on(Event.MACHINE_LOST, ({ machine }) => console.log("lost", machine.id));

await rig.open();

const machine = await rig.machine.create("worker"); // null if no room anywhere

if (machine) {
    await rig.machine.wait(machine.id, Status.RUNNING); // then: ssh debian@<machine.ip.public>
}
```

## What It Does

- **Failover:** tries the next place when a try finds no room: another zone, another type, `spot` → `demand`, another provider.
- **Risk:** estimates each place's take-back rate, from the type's shape at first and its own counts after, and drops places above a kind's `risk.max`.
- **Recover:** replaces a lost machine, up to the kind's `recovers`, after ending it so its provider removes what it left.
- **Guard:** warns about risky kinds when it opens: spot whose data a take-back loses, spot for a long life, spot on too few places.

## Kinds

A kind is a named recipe for machines. A preset makes one from a name ([Presets](#presets)); or write it yourself.

```ts
{
    name: "worker",
    try: [
        { provider: "aws", market: [Market.SPOT, Market.DEMAND], types: ["c8g.2xlarge", "c7g.2xlarge"] },
        { provider: "gcp", market: [Market.DEMAND], types: ["c4a-standard-8"] },
    ],
    distro: { name: Distro.UBUNTU },
    disk: 100,
    login: { keys: ["ssh-ed25519 AAAA..."] },
    script: ["apt-get update", "apt-get install -y nginx"],
    ports: [{ port: 443, from: From.ANY }],
    risk: { max: "10%" },
}
```

| Key        | Default        | Is                                                                          |
| ---------- | -------------- | --------------------------------------------------------------------------- |
| `name`     | —              | unique among kinds                                                          |
| `try`      | —              | where to try, in failover order: entries, below                             |
| `distro`   | Ubuntu `24.04` | the distro every machine boots: [Distro](#distro)                           |
| `disk`     | the provider's | GB of the boot disk, from `30`                                              |
| `login`    | none           | SSH keys for a user with `sudo`: [Login and Script](#login-and-script)      |
| `script`   | none           | what every machine runs once, at first boot                                 |
| `ports`    | none           | the only inbound ports open: [Disk and Ports](#disk-and-ports)              |
| `risk`     | none           | `{ max: "10%" }`: places with a higher take-back rate a month are not tried |
| `life`     | never          | the core ends each machine after this: `"8h"`                               |
| `recovers` | `3`            | how many times a lost machine is replaced                                   |
| `tags`     | none           | the app's own tags on every machine; no key starts with `rig`               |

| Entry key  | Is                                                                   |
| ---------- | -------------------------------------------------------------------- |
| `provider` | a provider's `name`                                                  |
| `market`   | `[Market.SPOT, Market.DEMAND]`, in order; always a list              |
| `types`    | the provider's type names, best first                                |
| `image`    | this provider's Linux image id, booted as it is in place of `distro` |
| `extra`    | the provider's own create options                                    |

### Distro

```ts
// each machine boots the version's newest image, on arm or x86 as its type is
const worker = aws.presets.compute({ name: "worker", distro: { name: Distro.DEBIAN, version: "13" } });
```

| `Distro` | Versions         | Default | Login user |
| -------- | ---------------- | ------- | ---------- |
| `UBUNTU` | `24.04`, `22.04` | `24.04` | `ubuntu`   |
| `DEBIAN` | `13`, `12`       | `12`    | `debian`   |

The provider finds the version's newest image each time it creates a machine, so new builds come in on their own, recovered machines too; `machine.image` is the one a machine boots. An entry's `image` boots one exact image of that provider in its place.

### Login and Script

```ts
const web = aws.presets.small({
    name: "web",
    distro: { name: Distro.DEBIAN },
    login: { keys: ["ssh-ed25519 AAAA... me@laptop"] }, // ssh debian@<ip>, on every cloud
    script: ["apt-get update", "apt-get install -y nginx", "systemctl enable --now nginx"], // or one str
});
```

| Key          | Is                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `login.keys` | SSH public keys, at least one                                                                               |
| `login.user` | who they sign in as, with `sudo`; by default the distro's login user; required with an entry's `image`      |
| `script`     | a script of your own, or its lines, joined by newlines; one with its own `#!` runs under it, else by `bash` |

At first boot, once, as root, every machine signs in its `login`, then runs its `script`: the core builds both into one bash script, the same on every provider and distro (spec §6.2). Its output goes to `/var/log/rig/boot.log`, and its exit code to `/var/lib/rig/boot.exit`; a failed first boot is not run again. `machine.user` is the login user.

### Disk and Ports

```ts
// at create: the boot disk, in GB, from 30, and the only inbound ports open; all else is closed, inside its network too
const worker = aws.presets.compute({ name: "worker", disk: 100, ports: [{ port: 22, from: "1.2.3.4/32" }] });

// later
await rig.disk.grow(machine.id, 200);
await rig.disk.wait(machine.id);
await rig.port.open(machine.id, { port: 443, from: From.ANY }); // two rules: 0.0.0.0/0 and ::/0
await rig.port.open(machine.id, { port: 53, proto: Proto.UDP, from: "10.0.0.0/8" });

await rig.port.close(machine.id, { port: 443 }); // every rule a match matches; or a rule's id
await rig.port.close(machine.id, { proto: Proto.UDP, from: "10.0.0.0/8" });
```

The provider sets the kind's ports as it makes the machine, so it is never open before they are.

| Call         | Rule                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `disk.grow`  | only grows: a size not above the disk's now is a refusal                                                                              |
| `port.open`  | `port` and `to` from `1` to `65535`, `proto` a `Proto` (`TCP` by default), `from` a CIDR or a `From`; else a refusal naming the field |
| `port.open`  | gives back the rules it opened: two for `From.ANY`; a rule the machine already has is given back, not added twice                     |
| `port.close` | takes a rule's id, or a match: `port`, `to`, `proto`, `from`, any of them; closes every rule it matches, and gives them back          |
| `port.close` | a rule already gone, or a match with none, is `[]`                                                                                    |

| `From` | Is                            |
| ------ | ----------------------------- |
| `ANY`  | anywhere: IPv4 and IPv6       |
| `ANY4` | anywhere on IPv4: `0.0.0.0/0` |
| `ANY6` | anywhere on IPv6: `::/0`      |

## Presets

Every provider has the same five, so the app needs no type names (spec §7):

| Preset    | For                     | Size option | Default market                 | Default disk (GB) |
| --------- | ----------------------- | ----------- | ------------------------------ | ----------------- |
| `small`   | a light, long-lived box | —           | `[Market.DEMAND]`              | `30`              |
| `general` | balanced cpu and memory | `cpu`: `2`  | `[Market.DEMAND]`              | `30 + 5 × cpu`    |
| `compute` | cpu-heavy work          | `cpu`: `4`  | `[Market.SPOT, Market.DEMAND]` | `30 + 5 × cpu`    |
| `memory`  | memory-heavy work       | `mem`: `32` | `[Market.DEMAND]`              | `30 + mem / 2`    |
| `gpu`     | gpu work                | `gpu`       | `[Market.SPOT, Market.DEMAND]` | `200`             |

```ts
aws.presets.compute({ name: "worker", cpu: 16, up: 1 }); // every 16 vCPU type, then every 32 vCPU type
```

Only `name` is required. The other options are `arch`, `up`, `market`, `image`, and any kind key; each provider's README lists its types.

## Calls

| Call                                                                | Does                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `open()`, `close()`                                                 | checks the config and every provider, then starts rounds; stops them    |
| `round()`                                                           | a round now: finds lost machines, recovers them, ends those past `life` |
| `on(event, handler)`                                                | hears an event: [Events](#events)                                       |
| `place.list(kind)`                                                  | the places a failover would try, in order, each with its risk           |
| `machine.create(kind)`                                              | a machine, by failover; `null` when there is no room anywhere           |
| `machine.get(id)`, `machine.list({ kind? })`                        | live from the provider; from the store                                  |
| `machine.wait(id, status, timeout?)`                                | until the machine has `status`, or is ended                             |
| `machine.end(id)`, `start`, `stop`, `reboot`                        | the provider's; `stop` on a spot machine is a refusal                   |
| `disk.grow(id, gb)`, `disk.get(id)`, `disk.wait(id)`                | the boot disk                                                           |
| `port.open(id, rule)`, `port.close(id, idOrMatch)`, `port.list(id)` | inbound port rules                                                      |

A call that cannot be done is a `Refusal`, with a `reason`: `Reason.CONFIG`, `UNKNOWN`, `UNSUPPORTED`, ...

## Events

| `Event`             | Data                      | When                                     |
| ------------------- | ------------------------- | ---------------------------------------- |
| `TRY`               | `{ kind, place, answer }` | after every try                          |
| `MACHINE_CREATED`   | `{ machine }`             | `machine.create` gave a machine          |
| `MACHINE_ENDED`     | `{ machine }`             | the core ended a machine                 |
| `MACHINE_LOST`      | `{ machine }`             | a machine ended without the core         |
| `MACHINE_RECOVERED` | `{ lost, machine }`       | a recover gave a machine                 |
| `MACHINE_FAILED`    | `{ machine, recovers }`   | lost, with its `recovers` spent          |
| `MACHINE_ORPHAN`    | `{ machine }`             | a machine of this app, of no kind it has |
| `GUARD`             | `{ kind, code }`          | a risky kind, when the core opens        |

## Config

| Key         | Default      | Is                                             |
| ----------- | ------------ | ---------------------------------------------- |
| `rig`       | —            | the generation: `1`                            |
| `app`       | —            | this app's name; it tags every machine         |
| `providers` | —            | at least one                                   |
| `kinds`     | —            | at least one                                   |
| `guard`     | `Guard.WARN` | `Guard.WARN` or `Guard.REFUSE`                 |
| `every`     | `"30s"`      | time between rounds; `"0"`: only `rig.round()` |
| `poll`      | `"5s"`       | time between polls of a wait                   |
| `store`     | `"./.rig"`   | the folder for what the core knows             |
| `extra`     | —            | `clock`, `sleep`, `rounds`: for tests          |

## Enums

Every fixed set of values in the spec is an enum; each value is the spec's own string, so JSON and the store read the same.

| Enum         | Members                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `Market`     | `SPOT`, `DEMAND`                                                                                                            |
| `Status`     | `PENDING`, `RUNNING`, `STOPPING`, `STOPPED`, `ENDING`, `ENDED`                                                              |
| `Busy`       | `ZONE`, `TYPE`, `MARKET`, `ACCOUNT`                                                                                         |
| `Arch`       | `ARM`, `X86`                                                                                                                |
| `Distro`     | `UBUNTU`, `DEBIAN`                                                                                                          |
| `From`       | `ANY`, `ANY4`, `ANY6`                                                                                                       |
| `Proto`      | `TCP`, `UDP`                                                                                                                |
| `Slot`       | `PROVIDER`, `HUB`                                                                                                           |
| `Guard`      | `WARN`, `REFUSE`                                                                                                            |
| `Finding`    | `SPOT_WARN`, `SPOT_LONG`, `SPOT_NARROW`                                                                                     |
| `Event`      | `TRY`, `MACHINE_CREATED`, `MACHINE_ENDED`, `MACHINE_LOST`, `MACHINE_RECOVERED`, `MACHINE_FAILED`, `MACHINE_ORPHAN`, `GUARD` |
| `Reason`     | `GENERATION`, `PLUGIN`, `CONFIG`, `GUARD`, `UNSUPPORTED`, `UNKNOWN`, `CLOSED`, `TIMEOUT`                                    |
| `State`      | `NEW`, `OPEN`, `CLOSED`                                                                                                     |
| `PresetName` | `SMALL`, `GENERAL`, `COMPUTE`, `MEMORY`, `GPU`                                                                              |
| `PresetArch` | `ARM`, `X86`, `ANY`                                                                                                         |

## Your Own Provider

A provider is an object with the calls of spec §9, made by a factory that takes the same config as the official ones (spec §8.2); `can` names what it supports. The core gives it the helpers the official ones use:

| Helper              | Makes                                                         |
| ------------------- | ------------------------------------------------------------- |
| `createPresets`     | the five presets, from its type table                         |
| `createDistroTable` | its `distros`, and each version's pointer to its newest image |
| `checkFactory`      | the check of its factory's config                             |
| `createTagMap`      | its tag names, both ways                                      |

## Spec

The core follows [rig generation 1](../../spec/SPEC.md), proven by [the kit](../../spec/kit).
