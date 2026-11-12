# @diphyx/rig-azure

The **azure** provider for [RIG](../core): Linux machines on Azure Virtual Machines, `spot` and `demand`, in one region.

**Status: draft.**

**Setup guide: [Azure](https://diphyx.github.io/rig/#/azure)**

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-azure
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createAzure } from "@diphyx/rig-azure";

// its region: RIG_AZURE_REGION, AZURE_LOCATION, else eastus; its subscription: RIG_AZURE_SUBSCRIPTION, AZURE_SUBSCRIPTION_ID
const azure = createAzure();

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [azure],
    kinds: [
        azure.presets.small({ name: "dev" }), // a light box, on demand
        azure.presets.compute({ name: "worker", cpu: 8 }), // 8 vCPU, spot first, then demand
    ],
});
```

## Auth

The same three ways as every RIG provider (spec §8.1), as `AuthFrom`:

```ts
createAzure(); // auto: env, the az login, or a managed identity
createAzure({ auth: { from: AuthFrom.ENV } }); // RIG_AZURE_TENANT, RIG_AZURE_ID, RIG_AZURE_SECRET
createAzure({ auth: { from: AuthFrom.KEYS, keys: { tenant, id, secret } } });
```

The keys are a service principal's `tenant`, `id` and `secret`. A missing key is a refusal at once, naming the key.

## Config

The same keys as every RIG provider's factory (spec §8.2); azure's own go in `extra`, and any other key is a refusal.

| Option               | Default                                                             | Is                                                                    |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `region`             | `RIG_AZURE_REGION`, `AZURE_LOCATION`, `AZURE_REGION`, else `eastus` | the Azure region                                                      |
| `name`               | `"azure"`                                                           | its name in the config; two regions are two providers, with two names |
| `auth`               | `{ from: AuthFrom.AUTO }`                                           | how it signs in: [Auth](#auth)                                        |
| `identity`           | none                                                                | what its machines run as: a user-assigned identity's resource id      |
| `extra.subscription` | `RIG_AZURE_SUBSCRIPTION`, `AZURE_SUBSCRIPTION_ID`                   | the subscription; one of them is required                             |
| `extra.group`        | `"rig"`, made on first use                                          | the resource group its machines go in                                 |
| `extra.subnet`       | a network of RIG's own, made on first use                           | a subnet's resource id                                                |
| `extra.request`      | Azure Resource Manager's REST API                                   | for tests: answers in place of Azure                                  |

## What It Does on Azure

It calls Azure Resource Manager's REST API, signed in with Azure's own `@azure/identity`.

| RIG                       | Azure                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                   | reads the subscription and its regions: the keys, the subscription and the region work                                                                                                      |
| `places`                  | the region's resource SKUs: each size's zones, less those closed to the subscription; `eastus-1` is zone 1 of `eastus`, and a region with no zones is one place, `eastus`                   |
| `create`                  | the group and network once, then one virtual machine, waited for, with its OS disk, network card and public IP                                                                              |
| `spot`                    | `priority: Spot`, deleted on a take-back                                                                                                                                                    |
| `distro`, `image`         | the kind's `distro`: its Marketplace image's newest version for the size's arch; or the entry's `image` (a resource id, or `publisher:offer:sku:version`) as it is                          |
| `script`, `login`         | the first-boot script (spec §6.2) as `customData`, run by cloud-init at first boot; Azure's own admin user, `rig`, signs in by a key whose private half is thrown away, and has no password |
| `get`, `list`             | the machine, its addresses from its card and IP; the group's machines in the region, every page, with every card's addresses read once                                                      |
| `start`, `stop`, `reboot` | `start`, `deallocate`, `restart`; stopping a spot machine is `unsupported`                                                                                                                  |
| `end`                     | the machine deleted with its disk, card and IP, then its security group; groups left by machines gone earlier go too                                                                        |
| `disk.grow`, `get`        | resizes the OS disk; ready once its change has succeeded                                                                                                                                    |
| `port.*`                  | a network security group of the machine's own, made before it with the kind's `ports` and a deny-all                                                                                        |

Busy answers come from [`src/azure.json`](src/azure.json): no room in a zone (`ZonalAllocationFailed`, `AllocationFailed`, `SkuNotAvailable`, ...), or in the subscription (`QuotaExceeded`, and `OperationNotAllowed` when it names a quota); Azure's inner error, in `details`, is read first. A region without the distro's image for a size's arch is no room for that type, so failover moves on. A type not in the data file needs its entry's own `image`, as its arch is unknown. Any other error is thrown.

### Ports

A new machine is behind a network security group of its own, made before it and set on its card: the kind's `ports`, and a deny-all inbound below them (`4096`, above the network's own allow). Every other inbound port is closed, inside the network too. `port.open` adds to them, and a failed try leaves nothing it made: a machine Azure kept as failed is deleted, then its group.

### Distro

Each version is a Marketplace image, `publisher:offer:sku`; its newest version is taken:

| Distro | Version | arm                                                      | x86                                                     |
| ------ | ------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Ubuntu | `24.04` | `Canonical:ubuntu-24_04-lts:server-arm64`                | `Canonical:ubuntu-24_04-lts:server`                     |
| Ubuntu | `22.04` | `Canonical:0001-com-ubuntu-server-jammy:22_04-lts-arm64` | `Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2` |
| Debian | `13`    | `Debian:debian-13:13-arm64`                              | `Debian:debian-13:13-gen2`                              |
| Debian | `12`    | `Debian:debian-12:12-arm64`                              | `Debian:debian-12:12-gen2`                              |

The machine's `image` is the image it boots, by its URN with its exact version.

## Presets

The same five presets as every RIG provider (spec §7), made by the core's preset engine from [`src/azure.json`](src/azure.json), newest generation first.

| Preset    | Size       | Default size | Default market                 | Default disk (GB) | arm                   | x86                                                               |
| --------- | ---------- | ------------ | ------------------------------ | ----------------- | --------------------- | ----------------------------------------------------------------- |
| `small`   | —          | —            | `[Market.DEMAND]`              | `30`              | `B2pls_v2`, `B2ps_v2` | `B2s`, `B2als_v2`                                                 |
| `general` | `cpu`      | `2`          | `[Market.DEMAND]`              | `30 + 5 × cpu`    | `Dps_v6`, `Dps_v5`    | `Ds_v6`, `Das_v6`, `Ds_v5`, `Das_v5`                              |
| `compute` | `cpu`      | `4`          | `[Market.SPOT, Market.DEMAND]` | `30 + 5 × cpu`    | `Dpls_v6`, `Dpls_v5`  | `Fas_v6`, `Fs_v2`                                                 |
| `memory`  | `mem` (GB) | `32`         | `[Market.DEMAND]`              | `30 + mem / 2`    | `Eps_v6`, `Eps_v5`    | `Es_v6`, `Eas_v6`, `Es_v5`, `Eas_v5`                              |
| `gpu`     | `gpu`      | `t4`         | `[Market.SPOT, Market.DEMAND]` | `200`             | —                     | `NCas_T4_v3` (T4), `NCads_A100_v4` (A100), `NCads_H100_v5` (H100) |

Only `name` is required; every other option has a strong default.

| Option              | Default                                                    | Is                                                                                           |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cpu`, `mem`, `gpu` | per preset                                                 | the size, rounded up to the next one sold                                                    |
| `arch`              | `PresetArch.ANY`: Cobalt and Ampere first, then x86        | `PresetArch.ARM`, `X86` or `ANY`; with your own `image`, one arch only; a `distro` fits both |
| `up`                | `0`                                                        | also try the next `up` sizes, after every type of the asked size                             |
| `image`             | —                                                          | this provider's image id: the entry's `image`, booted in place of `distro`                   |
| `disk`              | per preset, from the asked size; with `image`, the image's | GB of the boot disk                                                                          |
| `market`            | per preset                                                 | in failover order                                                                            |
| kind keys           | —                                                          | `distro`, `login`, `script`, `ports`, `worker`, `risk`, `life`, `recovers`, `tags`           |

```ts
azure.presets.compute({ name: "worker" });
// spot, then demand; 4 vCPU: D4pls_v6, D4pls_v5, then F4as_v6, F4s_v2

azure.presets.compute({ name: "worker", cpu: 16, up: 1 });
// every 16 vCPU type first, then every 32 vCPU type
```

`places` gives only the types each zone sells.

## Risk

The core estimates each place's take-back risk itself (spec §15). This provider gives it each type's shape, read from the type's name and [`src/azure.json`](src/azure.json):

```ts
await azure.shape("Standard_D4ps_v6"); // { cpu: 4, mem: 16, arch: Arch.ARM }
await azure.shape("Standard_NC4as_T4_v3"); // { cpu: 4, mem: 28, gpu: "t4", arch: Arch.X86 }
```

## Spot

Spot Virtual Machines, with a 30-second warning before a take-back, seen from inside the machine. The core finds a take-back on its next round, ends the machine so nothing it held is left, and recovers it.

A full spot quota is no room in spot, not in the account: the core tries the entry's demand machines next.

## Spec

The provider follows [RIG generation 1](../../spec/SPEC.md), Part 3.
