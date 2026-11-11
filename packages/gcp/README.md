# @diphyx/rig-gcp

The **gcp** provider for [RIG](../core): Linux machines on Google Compute Engine, `spot` and `demand`, in one region.

**Status: draft.** Tested against a fake Compute Engine.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-gcp
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createGcp } from "@diphyx/rig-gcp";

// its region: CLOUDSDK_COMPUTE_REGION, else us-central1; its project: the key's
const gcp = createGcp();

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [gcp],
    kinds: [
        gcp.presets.small({ name: "dev" }), // a light box, on demand
        gcp.presets.compute({ name: "worker", cpu: 8 }), // 8 vCPU, spot first, then demand
    ],
});
```

## Auth

The same three ways as every RIG provider (spec §8.1), as `AuthFrom`:

```ts
createGcp(); // auto: env, the gcloud login, or the machine's service account
createGcp({ auth: { from: AuthFrom.ENV } }); // RIG_GCP_KEY
createGcp({ auth: { from: AuthFrom.KEYS, keys: { key } } });
```

The key is a service-account key's JSON. A missing key is a refusal at once, naming the key.

## Config

The same keys as every RIG provider's factory (spec §8.2); gcp's own go in `extra`, and any other key is a refusal.

| Option          | Default                                                              | Is                                                                    |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `region`        | `CLOUDSDK_COMPUTE_REGION`, `GOOGLE_CLOUD_REGION`, else `us-central1` | the Compute Engine region                                             |
| `name`          | `"gcp"`                                                              | its name in the config; two regions are two providers, with two names |
| `auth`          | `{ from: AuthFrom.AUTO }`                                            | how it signs in: [Auth](#auth)                                        |
| `identity`      | none                                                                 | what its machines run as: a service account's email                   |
| `extra.project` | the key's, or the one Google's sign-in gives                         | the project                                                           |
| `extra.network` | `global/networks/default`                                            | the VPC network                                                       |
| `extra.subnet`  | the network's own, in the region                                     | a subnet: `regions/us-central1/subnetworks/main`                      |
| `extra.request` | Compute Engine's REST API                                            | for tests: answers in place of Compute Engine                         |

## What It Does on Compute Engine

It calls Compute Engine's REST API, signed in with Google's own `google-auth-library`.

| RIG                       | Compute Engine                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                   | reads the region: the keys, the project and the region work                                                                                                                                                                         |
| `places`                  | the region's zones that list the entry's machine types                                                                                                                                                                              |
| `create`                  | one `instances.insert`, waited for; labelled with the tags, the whole RIG name kept on its metadata, as a label holds 63 characters; a failed try deletes what it made; the id is its zone and name, `us-central1-a/app-w-0a1b2c3d` |
| `spot`                    | `provisioningModel: SPOT`, deleted on a take-back                                                                                                                                                                                   |
| `distro`, `image`         | the kind's `distro`: its image family's newest image for the type's arch, kept on the machine's metadata as `rig-image`; or the entry's `image` as it is                                                                            |
| `script`, `login`         | the first-boot script (spec §6.2) as the `startup-script` metadata, run by the guest agent at every boot; the script itself runs once                                                                                               |
| `get`, `list`             | `instances.get`, `instances.aggregatedList` in the region's zones, every page                                                                                                                                                       |
| `start`, `stop`, `reboot` | `start`, `stop`, `reset`; stopping a spot machine is `unsupported`                                                                                                                                                                  |
| `end`                     | the machine deleted, then its firewall rules, so it is never open without its deny-all; a gone machine still loses its rules; the boot disk goes with the machine                                                                   |
| `disk.grow`, `get`        | `disks.resize` on the boot disk; ready once it is `READY`                                                                                                                                                                           |
| `port.*`                  | firewall rules aimed at the machine's own network tag, its name: its deny-all, the kind's `ports`, and the rules opened later                                                                                                       |

Busy answers come from [`src/gcp.json`](src/gcp.json): no room in a zone (`ZONE_RESOURCE_POOL_EXHAUSTED`, `..._WITH_DETAILS`), or in the project (`QUOTA_EXCEEDED`, `quotaExceeded`). A missing image family for the distro is no room for that type, so failover moves on. A type not in the data file needs its entry's own `image`, as its arch is unknown. Any other error is thrown.

### Ports

A new machine is behind firewall rules of its own, made before it: a deny-all inbound (IPv4 and IPv6, priority `1000`, above the network's own rules), and the kind's `ports` above it (`900`). Every other inbound port is closed, inside the network too. `port.open` adds to them, and a failed try leaves nothing it made.

### Distro

Each version is an image family, `<project>/<family>`; a family always gives its newest image:

| Distro | Version | arm                                     | x86                                     |
| ------ | ------- | --------------------------------------- | --------------------------------------- |
| Ubuntu | `24.04` | `ubuntu-os-cloud/ubuntu-2404-lts-arm64` | `ubuntu-os-cloud/ubuntu-2404-lts-amd64` |
| Ubuntu | `22.04` | `ubuntu-os-cloud/ubuntu-2204-lts-arm64` | `ubuntu-os-cloud/ubuntu-2204-lts`       |
| Debian | `13`    | `debian-cloud/debian-13-arm64`          | `debian-cloud/debian-13`                |
| Debian | `12`    | `debian-cloud/debian-12-arm64`          | `debian-cloud/debian-12`                |

The machine's `image` is the image it boots, by its `<project>/<image>`.

## Presets

The same five presets as every RIG provider (spec §7), made by the core's preset engine from [`src/gcp.json`](src/gcp.json), newest generation first.

| Preset    | Size       | Default size | Default market                 | Default disk (GB) | arm          | x86                                 |
| --------- | ---------- | ------------ | ------------------------------ | ----------------- | ------------ | ----------------------------------- |
| `small`   | —          | —            | `[Market.DEMAND]`              | `30`              | `t2a`, `c4a` | `e2-small`, `e2-medium`             |
| `general` | `cpu`      | `2`          | `[Market.DEMAND]`              | `30 + 5 × cpu`    | `c4a`, `t2a` | `n4`, `n2`, `e2`                    |
| `compute` | `cpu`      | `4`          | `[Market.SPOT, Market.DEMAND]` | `30 + 5 × cpu`    | `c4a`        | `c3`, `n2`, `e2`                    |
| `memory`  | `mem` (GB) | `32`         | `[Market.DEMAND]`              | `30 + mem / 2`    | `c4a`        | `n4`, `n2`, `e2`                    |
| `gpu`     | `gpu`      | `l4`         | `[Market.SPOT, Market.DEMAND]` | `200`             | —            | `g2` (L4), `a2` (A100), `a3` (H100) |

Only `name` is required; every other option has a strong default.

| Option              | Default                                                    | Is                                                                                           |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cpu`, `mem`, `gpu` | per preset                                                 | the size, rounded up to the next one sold                                                    |
| `arch`              | `PresetArch.ANY`: Axion and Ampere first, then x86         | `PresetArch.ARM`, `X86` or `ANY`; with your own `image`, one arch only; a `distro` fits both |
| `up`                | `0`                                                        | also try the next `up` sizes, after every type of the asked size                             |
| `image`             | —                                                          | this provider's image id: the entry's `image`, booted in place of `distro`                   |
| `disk`              | per preset, from the asked size; with `image`, the image's | GB of the boot disk                                                                          |
| `market`            | per preset                                                 | in failover order                                                                            |
| kind keys           | —                                                          | `distro`, `login`, `script`, `ports`, `worker`, `risk`, `life`, `recovers`, `tags`           |

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

A full spot quota is no room in spot, not in the account: the core tries the entry's demand machines next.

## Spec

The provider follows [RIG generation 1](../../spec/SPEC.md), Part 3.
