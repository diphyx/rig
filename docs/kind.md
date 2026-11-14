# Kind

> A named recipe for machines: where to try, in order, and what each one boots

A kind says two things: **where** its machines may go, its `try` list, in failover order; and **what** each machine is, the same on every cloud. A preset writes one from a name; or write it yourself.

## 1. A Preset

Every provider has the same five, so the app needs no type names:

| Preset    | For                     | Size option         | Default market   | Default disk (GB) |
| --------- | ----------------------- | ------------------- | ---------------- | ----------------- |
| `small`   | a light, long-lived box | —                   | `demand`         | `30`              |
| `general` | balanced cpu and memory | `cpu`: `2`          | `demand`         | `30 + 5 × cpu`    |
| `compute` | cpu-heavy work          | `cpu`: `4`          | `spot`, `demand` | `30 + 5 × cpu`    |
| `memory`  | memory-heavy work       | `mem`: `32`         | `demand`         | `30 + mem / 2`    |
| `gpu`     | gpu work                | `gpu`: the cheapest | `spot`, `demand` | `200`             |

```ts
// spot, then demand; every 16 vCPU type, then every 32 vCPU type
const worker = aws.presets.compute({
    name: "worker",
    cpu: 16,
    up: 1,
});
```

| Option              | Default                                          | Is                                                                                         |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `name`              | —                                                | the kind's name; the only one required                                                     |
| `cpu`, `mem`, `gpu` | per preset                                       | the size: `cpu` and `mem` rounded up to the next one sold; `gpu` a model, as named         |
| `arch`              | `PresetArch.ANY`: arm's types, then x86's        | `ARM`, `X86` or `ANY`; with `image`, one arch: `ARM` if sold, else `X86`                   |
| `up`                | `0`                                              | also try the next `up` sizes, after every type of the asked size                           |
| `market`            | per preset                                       | in failover order                                                                          |
| `image`             | —                                                | the provider's own image id, booted in place of `distro`; with `login`, needs `login.user` |
| `disk`              | per preset, from the size; with `image`, its own | GB of the boot disk, rounded up to a multiple of 10                                        |
| kind keys           | —                                                | `distro`, `login`, `script`, `ports`, `worker`, `risk`, `life`, `recovers`, `tags`         |

Each provider's README lists its types, newest generation first.

## 2. Your Own

A kind written by hand can span clouds. The order of `try` is the order of failover:

```ts
import { type Kind, Market } from "@diphyx/rig";

// in the config: kinds: [worker]
const worker: Kind = {
    name: "worker",
    try: [
        { provider: "aws", market: [Market.SPOT], types: ["c8g.2xlarge", "c7g.2xlarge"] },
        { provider: "gcp", market: [Market.SPOT], types: ["c4a-standard-8"] },
        { provider: "aws", market: [Market.DEMAND], types: ["c8g.2xlarge"] },
    ],
    risk: { max: "10%" },
};
```

| Key        | Default        | Is                                                                  |
| ---------- | -------------- | ------------------------------------------------------------------- |
| `name`     | —              | unique among kinds                                                  |
| `try`      | —              | its entries, in failover order, below                               |
| `distro`   | Ubuntu `24.04` | what every machine boots: below                                     |
| `disk`     | the provider's | GB of the boot disk, from `30`                                      |
| `login`    | none           | SSH keys for a user with `sudo`: below                              |
| `script`   | none           | what every machine runs once, as root, at first boot                |
| `ports`    | none           | the only inbound ports open: below                                  |
| `worker`   | none           | its machines run jobs for a worker: [Worker](worker.md)             |
| `risk`     | none           | `{ max: "10%" }`: places with a higher take-back rate are not tried |
| `life`     | never          | the core ends each machine after this: `"8h"`                       |
| `recovers` | `3`            | how many times a lost machine is replaced                           |
| `tags`     | none           | the app's own tags on every machine; no key starts with `rig`       |

| Entry key  | Is                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------- |
| `provider` | a provider's `name`                                                                           |
| `market`   | `[Market.SPOT, Market.DEMAND]`, in order; always a list                                       |
| `types`    | the provider's type names, best first                                                         |
| `image`    | this provider's Linux image id, booted in place of `distro`; with `login`, needs `login.user` |
| `extra`    | the provider's own create options                                                             |

## 3. Distro

| `Distro` | Versions         | Default | Login user |
| -------- | ---------------- | ------- | ---------- |
| `UBUNTU` | `24.04`, `22.04` | `24.04` | `ubuntu`   |
| `DEBIAN` | `13`, `12`       | `12`    | `debian`   |

```ts
import { Distro } from "@diphyx/rig";

// each machine boots Debian 13's newest image, on arm or x86 as its type is
const worker = aws.presets.compute({
    name: "worker",
    distro: { name: Distro.DEBIAN, version: "13" },
});
```

A distro is a line of images, not one: the provider finds the version's newest image each time it creates a machine, so new builds come in on their own, recovered machines too. `machine.image` is the one it boots. A region without the image for a type's arch is no room for that type: failover moves on.

## 4. Login and Script

```ts
const web = aws.presets.small({
    name: "web",
    distro: { name: Distro.DEBIAN },
    // ssh debian@<ip>, on every cloud
    login: {
        keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGm5nRrnDrU0H8wXkVhQvTq1aXj4Q0bQ0aQ0bQ0aQ0bQ me@laptop"],
    },
    // its lines, or one str
    script: ["apt-get update", "apt-get install -y nginx", "systemctl enable --now nginx"],
});
```

At first boot, the core's one bash script runs, once, as root, the same on every cloud and distro:

1. **`login`:** the user, the distro's or `login.user`, gets the keys and `sudo` without a password.
2. **the worker's lines,** when the kind has a `worker`.
3. **`script`:** yours; under its own `#!` if it has one, else by `bash`.
4. **the worker's start,** when it has one: what takes jobs, once your `script` is done.

Its output goes to `/var/log/rig/boot.log`, its exit code to `/var/lib/rig/boot.exit`. A failed first boot is not run again. The whole script fits in 16 KB.

## 5. Disk and Ports

```ts
import { From, Protocol } from "@diphyx/rig";

// at create: the boot disk, and the only inbound ports open; all else is closed, inside its network too
const worker = aws.presets.compute({
    name: "worker",
    disk: 100,
    ports: [{ port: 22, from: "1.2.3.4" }],
});

// later, for a machine it made
await rig.disk.grow(machine.id, 200);
await rig.disk.wait(machine.id);

await rig.port.open(machine.id, { port: 443, from: From.ANY }); // two rules: 0.0.0.0/0 and ::/0
await rig.port.open(machine.id, { port: 53, protocol: Protocol.UDP, from: "10.0.0.0/8" });
await rig.port.close(machine.id, { port: 443 }); // every rule it matches; or a rule's id
```

| Rule key   | Is                                                                            |
| ---------- | ----------------------------------------------------------------------------- |
| `port`     | the port, or the first of a range: `1` to `65535`                             |
| `to`       | the last port of a range                                                      |
| `protocol` | `Protocol.TCP`, the default, or `UDP`                                         |
| `from`     | an IP (its `/32` or `/128`), a CIDR, or `From.ANY` (two rules: IPv4 and IPv6) |

The provider sets the kind's ports as it makes the machine, so it is never open before they are. A disk only grows.

## 6. Per Machine

`machine.create` takes options over the kind, for that one machine: its `worker`, so one kind makes machines for different work.

```ts
await rig.machine.create("builder", {
    worker: {
        tags: ["req-42"],
        cmds: {
            train: { exec: ["python", "train.py"], timeout: "4h" },
        },
    },
});
```

The options are checked at the call, as the kind's own are when RIG opens, and kept with the machine: its replacement, when it is lost, gets the same. More in [Worker](worker.md).
