# @diphyx/rig-gcp

The **gcp** provider for [rig](../core): Google Compute Engine, `spot` and `demand`, in one region.

**Status: draft.** Tested against a fake Compute Engine.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-gcp
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createGcp } from "@diphyx/rig-gcp";

const gcp = createGcp({ region: "us-central1", extra: { project: "my-project" } });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [gcp],
    kinds: [gcp.presets.small({ name: "dev" }), gcp.presets.compute({ name: "worker", cpu: 8 })],
});
```

## Auth

The same three ways as every rig provider (spec §8.1), as `AuthFrom`:

```ts
createGcp({ region: "us-central1" }); // auto: env, the gcloud login, or the machine's service account
createGcp({ region: "us-central1", auth: { from: AuthFrom.ENV } }); // RIG_GCP_KEY
createGcp({ region: "us-central1", auth: { from: AuthFrom.KEYS, keys: { key } } });
```

The key is a service-account key's JSON. A missing key is a refusal at once, naming the key.

## Config

The same keys as every rig provider's factory (spec §8.2); gcp's own go in `extra`, and any other key is a refusal.

| Option          | Default                                      | Is                                                                    |
| --------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `region`        | —                                            | the Compute Engine region                                             |
| `name`          | `"gcp"`                                      | its name in the config; two regions are two providers, with two names |
| `auth`          | `{ from: AuthFrom.AUTO }`                    | how it signs in: [Auth](#auth)                                        |
| `identity`      | none                                         | what its machines run as: a service account's email                   |
| `extra.project` | the key's, or the one Google's sign-in gives | the project                                                           |
| `extra.network` | `global/networks/default`                    | the VPC network                                                       |
| `extra.subnet`  | the network's own, in the region             | a subnet: `regions/us-central1/subnetworks/main`                      |
| `extra.request` | Compute Engine's REST API                    | for tests: answers in place of Compute Engine                         |

## What It Does on Compute Engine

It calls Compute Engine's REST API, signed in with Google's own `google-auth-library`.

| rig                       | Compute Engine                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                   | reads the region: the keys, the project and the region work                                                                               |
| `places`                  | the region's zones that list the entry's machine types                                                                                    |
| `create`                  | one `instances.insert`, waited for; labelled with the tags; the id is its zone and name, `us-central1-a/app-w-0a1b2c3d`, in 63 characters |
| `spot`                    | `provisioningModel: SPOT`, deleted on a take-back                                                                                         |
| image                     | the kind's, or Ubuntu 24.04 (arm64 or amd64, by type) from Canonical's image family                                                       |
| `get`, `list`             | `instances.get`, `instances.aggregatedList` in the region's zones, every page                                                             |
| `start`, `stop`, `reboot` | `start`, `stop`, `reset`; stopping a spot machine is `unsupported`                                                                        |
| `end`                     | the machine's firewall rules deleted, then the machine; a gone machine still loses its rules; the boot disk goes with the machine         |
| `disk.grow`, `get`        | `disks.resize` on the boot disk; ready once it is `READY`                                                                                 |
| `port.*`                  | firewall rules aimed at the machine's own network tag, its name                                                                           |

Busy answers come from [`src/gcp.json`](src/gcp.json): no room in a zone (`ZONE_RESOURCE_POOL_EXHAUSTED`, `..._WITH_DETAILS`), or in the project (`QUOTA_EXCEEDED`, `quotaExceeded`). Any other error is thrown.

## Presets

The same five presets as every rig provider (spec §7), made by the core's preset engine from [`src/gcp.json`](src/gcp.json), newest generation first.

| Preset    | Size       | Default size | Default market                 | arm          | x86                                 |
| --------- | ---------- | ------------ | ------------------------------ | ------------ | ----------------------------------- |
| `small`   | —          | —            | `[Market.DEMAND]`              | `t2a`, `c4a` | `e2-small`, `e2-medium`             |
| `general` | `cpu`      | `2`          | `[Market.DEMAND]`              | `c4a`, `t2a` | `n4`, `n2`, `e2`                    |
| `compute` | `cpu`      | `4`          | `[Market.SPOT, Market.DEMAND]` | `c4a`        | `c3`, `n2`, `e2`                    |
| `memory`  | `mem` (GB) | `32`         | `[Market.DEMAND]`              | `c4a`        | `n4`, `n2`, `e2`                    |
| `gpu`     | `gpu`      | `l4`         | `[Market.SPOT, Market.DEMAND]` | —            | `g2` (L4), `a2` (A100), `a3` (H100) |

Only `name` is required; every other option has a strong default.

| Option              | Default                                            | Is                                                                     |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `cpu`, `mem`, `gpu` | per preset                                         | the size, rounded up to the next one sold                              |
| `arch`              | `PresetArch.ANY`: Axion and Ampere first, then x86 | `PresetArch.ARM`, `X86` or `ANY`; with your own `image`, one arch only |
| `up`                | `0`                                                | also try the next `up` sizes, after every type of the asked size       |
| `market`            | per preset                                         | in failover order                                                      |
| kind keys           | —                                                  | `image`, `disk`, `script`, `risk`, `life`, `recovers`, `tags`          |

```ts
gcp.presets.compute({ name: "worker" });
// spot, then demand; 4 vCPU: c4a, then c3, n2, e2

gcp.presets.compute({ name: "worker", cpu: 16, up: 1 });
// every 16 vCPU type first, then every 32 vCPU type
```

`places` gives only the types each zone sells.

## Risk

The core estimates each place's take-back risk itself (spec §15). This provider gives it each type's shape, read from the type's name and [`src/gcp.json`](src/gcp.json):

```ts
await gcp.shape("c4a-standard-8"); // { cpu: 8, mem: 32, arch: Arch.ARM }
await gcp.shape("g2-standard-4"); // { cpu: 4, mem: 16, gpu: "l4", arch: Arch.X86 }
```

## Spot

Spot VMs, with a 30-second warning before a take-back, seen from inside the machine. The core finds a take-back on its next round, ends the machine so nothing it held is left, and recovers it.

## Spec

The provider follows [rig generation 1](../../spec/SPEC.md), Part 3.
