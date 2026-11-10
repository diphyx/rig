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
createGcp({ region: "us-central1" }); // auto: env, gcloud, or the machine's service account
createGcp({ region: "us-central1", auth: { from: AuthFrom.ENV } }); // RIG_GCP_KEY
createGcp({ region: "us-central1", auth: { from: AuthFrom.KEYS, keys: { key } } });
```

`key` is a service-account key's JSON. A key that is not one is a refusal at once, naming the key.

## Config

The same keys as every rig provider's factory (spec §8.2); gcp's own go in `extra`, and any other key is a refusal.

| Option          | Default                                      | Is                                                            |
| --------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `region`        | —                                            | the Compute Engine region                                     |
| `name`          | `"gcp"`                                      | the provider's name; two regions are two providers, two names |
| `auth`          | `{ from: AuthFrom.AUTO }`                    | how it signs in                                               |
| `identity`      | none                                         | what its machines run as: a service account's email           |
| `extra.project` | the key's, or the one Google's sign-in gives | the project                                                   |
| `extra.network` | `global/networks/default`                    | the VPC network                                               |
| `extra.subnet`  | the network's own, in the region             | a subnet: `regions/us-central1/subnetworks/main`              |

## What It Does on Compute Engine

It speaks Compute Engine's REST API, signed in with Google's own `google-auth-library`.

| rig                       | Compute Engine                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `check`                   | reads the region: the keys, the project and the region work                                                              |
| `places`                  | the region's zones that list the entry's machine types                                                                   |
| `create`                  | one `instances.insert`, waited for; labelled with the tags; `spot` is deleted on a take-back                             |
| id                        | the zone and name: `us-central1-a/app-w-0a1b2c3d`; names fit in 63 characters                                            |
| image                     | the kind's, or Ubuntu 24.04 (arm64 or amd64, by type) from Canonical's image family                                      |
| `get`, `list`             | `instances.get`, `instances.aggregatedList` in the region's zones, every page                                            |
| `start`, `stop`, `reboot` | `start`, `stop`, `reset`; stopping a spot machine is `unsupported`                                                       |
| `end`                     | deletes the machine's firewall rules, then the machine; a gone machine still loses its rules; its boot disk goes with it |
| `disk.grow`, `get`        | `disks.resize` on the boot disk; ready once it is `READY`                                                                |
| `port.*`                  | firewall rules aimed at the machine's own network tag, its name                                                          |

Busy answers come from [`src/gcp.json`](src/gcp.json): no room in a zone (`ZONE_RESOURCE_POOL_EXHAUSTED`, `..._WITH_DETAILS`), or in the project (`QUOTA_EXCEEDED`). Any other error is thrown.

## Presets

| Preset    | arm          | x86                                 | Default market                 |
| --------- | ------------ | ----------------------------------- | ------------------------------ |
| `small`   | `t2a`, `c4a` | `e2-small`, `e2-medium`             | `[Market.DEMAND]`              |
| `general` | `c4a`, `t2a` | `n4`, `n2`, `e2`                    | `[Market.DEMAND]`              |
| `compute` | `c4a`        | `c3`, `n2`, `e2`                    | `[Market.SPOT, Market.DEMAND]` |
| `memory`  | `c4a`        | `n4`, `n2`, `e2`                    | `[Market.DEMAND]`              |
| `gpu`     | —            | `g2` (L4), `a2` (A100), `a3` (H100) | `[Market.SPOT, Market.DEMAND]` |

The preset engine is the core's, the same on every provider; the type lists are in [`src/gcp.json`](src/gcp.json).

## Risk

The core estimates each place's take-back risk itself (spec §15). This provider gives it each type's shape, read from the type's name and [`src/gcp.json`](src/gcp.json):

```ts
await gcp.shape("c4a-standard-8"); // { cpu: 8, mem: 32, arch: Arch.ARM }
await gcp.shape("g2-standard-4"); // { cpu: 4, mem: 16, gpu: "l4", arch: Arch.X86 }
```

## Spot

Spot VMs: Compute Engine gives a 30-second warning before a take-back, seen from inside the machine; the core finds a take-back on its next round.

## Spec

The provider follows [rig generation 1](../../spec/SPEC.md), Part 3.
