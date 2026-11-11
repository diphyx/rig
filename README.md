# rig

**Remote Instance Gateway**

Create Linux machines on any cloud, with failover.

**Status: draft.** Spec, core and providers are written; none has run on a real cloud yet.

> [!IMPORTANT]
> **Linux only.** Every machine rig creates runs Linux: Ubuntu or Debian, or a Linux image of your own. Its first boot is a bash script, and its login is SSH.

## 1. What It Does

Creating one machine is easy. Getting one when the cloud has no room is not. Rig tries the next place until a machine is created:

```
   app: "a machine of kind worker"
              │
              ▼
            core ──► try ──► busy ──► next place ──► try ──► ... ──► machine
                              │
                              ├── another zone
                              ├── another type
                              ├── spot → demand
                              └── another provider
```

Rig makes two kinds of machines: ones that live as long as the app wants them, and, with a worker like grid, short-lived **job machines**, often spot, that run jobs and are replaced at will.

On `spot`, the provider may take a machine back. Rig estimates how often that happens per place, from each type's shape and its own counts, replaces lost machines, and warns about risky kinds when it opens.

## 2. A Taste

The TypeScript API: the core, and a provider per cloud.

```ts
import { createRig, Distro, Event, Status } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws(); // its region: AWS_REGION, else us-east-1

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    kinds: [
        aws.presets.small({ name: "dev" }),
        aws.presets.compute({
            name: "worker",
            cpu: 8, // spot first, then demand
            distro: { name: Distro.DEBIAN },
            login: {
                keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGm5nRrnDrU0H8wXkVhQvTq1aXj4Q0bQ0aQ0bQ0aQ0bQ me@laptop"],
            },
            script: ["apt-get update", "apt-get install -y nginx"],
            ports: [{ port: 22, from: "1.2.3.4/32" }],
        }),
    ],
});

rig.on(Event.MACHINE_LOST, ({ machine }) => console.log("lost", machine.id)); // rig recovers it

await rig.open();

const machine = await rig.machine.create("worker"); // null if no room anywhere

if (machine) {
    await rig.machine.wait(machine.id, Status.RUNNING); // then: ssh debian@<machine.ip.public>
}
```

A **kind** is a named recipe for machines. A **preset** (`small`, `general`, `compute`, `memory`, `gpu`) makes one from a name alone; every provider has the same five. Each kind sets, the same on every cloud:

| Key      | Is                                                                                      |
| -------- | --------------------------------------------------------------------------------------- |
| `distro` | Ubuntu or Debian, at a major version; each new machine gets that version's newest image |
| `disk`   | GB of the boot disk                                                                     |
| `login`  | SSH keys for the distro's user, with `sudo`                                             |
| `script` | what every machine runs once, as root, at first boot                                    |
| `ports`  | the only inbound ports open; all else is closed                                         |
| `worker` | its machines run jobs for a worker, like grid: short-lived job machines                 |
| `risk`   | the highest take-back rate a place may have                                             |

For full control, write the kind yourself, across providers. The order of `try` is the failover order:

```ts
{
    name: "worker",
    try: [
        { provider: "aws", market: [Market.SPOT],   types: ["c8g.2xlarge", "c7g.2xlarge"] },
        { provider: "gcp", market: [Market.SPOT],   types: ["c4a-standard-8"] },
        { provider: "aws", market: [Market.DEMAND], types: ["c8g.2xlarge"] },
    ],
    risk: { max: "10%" },
}
```

The [core's README](packages/core) has every key, call and event.

## 3. How It Is Built

```
                    core
        failover · risk · recover · guard
              │                    │
          providers             workers
     aws · gcp · azure · yours   grid · yours
       make the machines       run jobs on them
```

- **Spec first.** [`spec/SPEC.md`](spec/SPEC.md) is the contract, and [`spec/kit/`](spec/kit) proves it. Any core and any provider that follow it work together, in any language.
- **One official lib:** TypeScript, framework-free, a library.
- **Plugins.** Each cloud is a provider: official `aws`, `gcp`, `azure`, or your own. A worker runs jobs on the machines: official `grid`, or your own. Each is optional.
- **Generations.** Each major is a fixed contract, `rig: 1`. Minors and patches only add. A new generation starts fresh, with its own store and tags.

| Package             | Is                                | Needed   |
| ------------------- | --------------------------------- | -------- |
| `@diphyx/rig`       | the core                          | always   |
| `@diphyx/rig-aws`   | the aws provider                  | optional |
| `@diphyx/rig-gcp`   | the gcp provider                  | optional |
| `@diphyx/rig-azure` | the azure provider                | optional |
| `@diphyx/rig-grid`  | the grid worker: jobs on machines | optional |

At least one provider; workers only for job machines.

## 4. Develop

| Path             | Is                                                      |
| ---------------- | ------------------------------------------------------- |
| `spec/SPEC.md`   | the contract                                            |
| `spec/kit/`      | the conformance suite, as data                          |
| `packages/core`  | `@diphyx/rig`, passes the kit                           |
| `packages/aws`   | `@diphyx/rig-aws`, draft                                |
| `packages/gcp`   | `@diphyx/rig-gcp`, draft                                |
| `packages/azure` | `@diphyx/rig-azure`, draft                              |
| `packages/grid`  | `@diphyx/rig-grid`, draft                               |
| `test/`          | the same checks for every provider, and the kit's files |

```bash
pnpm install
pnpm run build   # every package
pnpm run check   # types, lint, format, tests, the kit
```

## License

MIT
