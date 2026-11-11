# Get Started

> From nothing to a first machine: install, sign in, a kind, open, create, SSH in

You need Node.js 22 or newer, and an account on one cloud. Below it is aws; gcp and azure are the same, with their own provider.

## 1. Install

The core and one provider:

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

| Package             | Is                                | Needed           |
| ------------------- | --------------------------------- | ---------------- |
| `@diphyx/rig`       | the core                          | always           |
| `@diphyx/rig-aws`   | the aws provider                  | one provider     |
| `@diphyx/rig-gcp`   | the gcp provider                  | or this one      |
| `@diphyx/rig-azure` | the azure provider                | or this one      |
| `@diphyx/rig-grid`  | the grid worker: jobs on machines | for job machines |

## 2. Sign In

A provider signs in with what the environment already has: the cloud's env vars, its CLI's login, or the machine's own identity. Nothing to set when `aws sts get-caller-identity` works:

```ts
import { createAws } from "@diphyx/rig-aws";

// its region: AWS_REGION, else us-east-1
const aws = createAws();
```

| Provider | Signs in with, by default                     | Its region, by default                                               |
| -------- | --------------------------------------------- | -------------------------------------------------------------------- |
| aws      | env, `~/.aws`, or the instance role           | `AWS_REGION`, `AWS_DEFAULT_REGION`, else `us-east-1`                 |
| gcp      | env, the gcloud login, or the service account | `CLOUDSDK_COMPUTE_REGION`, `GOOGLE_CLOUD_REGION`, else `us-central1` |
| azure    | env, the az login, or a managed identity      | `AZURE_LOCATION`, `AZURE_REGION`, else `eastus`                      |

Keys of its own, from env vars or passed in: [Provider](provider.md).

## 3. A Kind

A kind is a recipe for machines. A preset makes one from a name:

```ts
import { createRig, Distro, Event, Status } from "@diphyx/rig";

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    kinds: [
        aws.presets.compute({
            name: "worker",
            cpu: 8,
            distro: { name: Distro.DEBIAN },
            login: {
                keys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGm5nRrnDrU0H8wXkVhQvTq1aXj4Q0bQ0aQ0bQ0aQ0bQ me@laptop"],
            },
            ports: [{ port: 22, from: "1.2.3.4" }],
        }),
    ],
});
```

- **`compute`, 8 vCPU:** spot first, then demand; Graviton types, then x86; a 70 GB disk.
- **`distro`:** Debian 12's newest image, on arm or x86 as the type is.
- **`login`:** your SSH key, for the user `debian`, with `sudo`.
- **`ports`:** SSH from your IP only; every other inbound port is closed.

Every key: [Kind](kind.md).

## 4. Listen

Before it opens, so it hears the guard's findings too:

```ts
rig.on(Event.GUARD, ({ kind, code }) => {
    console.log("risky:", kind, code);
});

rig.on(Event.TRY, ({ place, answer }) => {
    console.log(place.zone, place.type, answer);
});

rig.on(Event.MACHINE_LOST, ({ machine }) => {
    console.log("taken back:", machine.id); // the core makes another in its place
});
```

## 5. Open

```ts
await rig.open();
```

The core checks the config, proves every provider's keys work, reads its store (`./.rig`), and starts its rounds, every 30 s. A config that is not right is a `Refusal` here, naming the key: `kinds[worker].disk: a uint from 30`.

## 6. Create

```ts
// null when no place has room
const machine = await rig.machine.create("worker");

if (!machine) {
    throw new Error("no room anywhere");
}

// the machine, once it runs: its IPs too
const running = await rig.machine.wait(machine.id, Status.RUNNING);

console.log(`ssh debian@${running.ip?.public}`);
```

The core tries the kind's places in order, and gives the first machine one makes. To see where it would try, and each place's risk, before it does:

```ts
const places = await rig.place.list("worker");
// [{ provider: "aws", market: "spot", type: "c8g.2xlarge", zone: "us-east-1a", risk: { takeback: 8, ... } }, ...]
```

## 7. End

```ts
// when its work is done
await rig.machine.end(running.id);

// rounds stop; no machine ends
await rig.close();
```

Open again later, and the core picks its machines up from its store.

## Next

- Several clouds in one kind, risk limits, your own kind: [Kind](kind.md).
- What the core does when there is no room, or a machine is lost: [Failover](failover.md).
- Jobs on short-lived machines, with grid: [Worker](worker.md).
