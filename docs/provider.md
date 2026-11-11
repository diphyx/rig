# Provider

> A plugin for one cloud: it makes machines, and the core does the rest

A provider makes one `create` per try, at the place the core asks for, and answers `ok` or `busy`. It never fails over on its own: that is the core's. Three are official, each its own package:

| Provider | Package                                                                       | Cloud                  | Spot warning before a take-back |
| -------- | ----------------------------------------------------------------------------- | ---------------------- | ------------------------------- |
| `aws`    | [`@diphyx/rig-aws`](https://github.com/diphyx/rig/tree/HEAD/packages/aws)     | Amazon EC2             | 2 minutes                       |
| `gcp`    | [`@diphyx/rig-gcp`](https://github.com/diphyx/rig/tree/HEAD/packages/gcp)     | Google Compute Engine  | 30 seconds                      |
| `azure`  | [`@diphyx/rig-azure`](https://github.com/diphyx/rig/tree/HEAD/packages/azure) | Azure Virtual Machines | 30 seconds                      |

## 1. Config

Every provider's factory takes the same keys, so changing cloud changes only `extra`:

```ts
import { createAws } from "@diphyx/rig-aws";

const east = createAws({ region: "us-east-1", name: "aws-east" });
const west = createAws({ region: "us-west-2", name: "aws-west" }); // two regions are two providers
```

| Key        | Default                                                           | Is                                                  |
| ---------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `region`   | `RIG_<NAME>_REGION`, else the cloud's env var's, else its default | where its machines go                               |
| `name`     | the cloud's own: `"aws"`                                          | its name in the config, as entries name it          |
| `auth`     | `{ from: AuthFrom.AUTO }`                                         | how it signs in, below                              |
| `identity` | none                                                              | what its machines run as: a role, a service account |
| `extra`    | —                                                                 | the provider's own: subnets, a project, a group     |

Any other key is a refusal, naming it.

## 2. Auth

The same three ways on every cloud:

```ts
import { AuthFrom, createAws } from "@diphyx/rig-aws";

// what the environment has: env vars, the CLI's login, the machine's identity
createAws();

// env vars: RIG_AWS_ID, RIG_AWS_SECRET, RIG_AWS_TOKEN?
createAws({ auth: { from: AuthFrom.ENV } });

// keys passed in
createAws({ auth: { from: AuthFrom.KEYS, keys: { id, secret } } });
```

| Provider | Keys                                          | From env, by default                                   |
| -------- | --------------------------------------------- | ------------------------------------------------------ |
| aws      | `id`, `secret`, `token?`: an access key       | `RIG_AWS_ID`, `RIG_AWS_SECRET`, `RIG_AWS_TOKEN`        |
| gcp      | `key`: a service account key's JSON           | `RIG_GCP_KEY`                                          |
| azure    | `tenant`, `id`, `secret`: a service principal | `RIG_AZURE_TENANT`, `RIG_AZURE_ID`, `RIG_AZURE_SECRET` |

- **A missing key** is a refusal at once, naming the key, never its value.
- **No secret** goes into the store, an event, a log or an error.
- **`check`** proves the keys work when the core opens: wrong keys, no access, an unknown region, each a refusal.

## 3. What It Does

The same calls on every cloud, each its own way:

| Call                         | Does                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `places`                     | the places sold now for an entry's markets and types                                |
| `create`                     | one try: tagged, the distro's newest image, the first-boot script, the kind's ports |
| `get`, `list`                | a machine by id; every machine with the core's tags, every page                     |
| `end`                        | the machine, and what it left: its port rules, its disks                            |
| `start`, `stop`, `reboot`    | the machine's power; `stop` on spot is a refusal                                    |
| `disk.grow`, `disk.get`      | the boot disk                                                                       |
| `port.open`, `close`, `list` | its inbound rules                                                                   |

| Provider | Ports                                                              | First-boot script               |
| -------- | ------------------------------------------------------------------ | ------------------------------- |
| aws      | a security group of its own, made before it                        | `UserData`, run by cloud-init   |
| gcp      | firewall rules at its own network tag: a deny-all, then the kind's | `startup-script`, run once      |
| azure    | a network security group of its own: the kind's, then a deny-all   | `customData`, run by cloud-init |

A try that is busy, or throws, leaves nothing it made. Each provider's README has its cloud's calls, its busy codes, its distro images and its types.

## 4. Its Data File

What is not code is data, `src/<name>.json`, so providers for one cloud agree in any language:

| Key       | Is                                                              |
| --------- | --------------------------------------------------------------- |
| `rig`     | its generation: `1`                                             |
| `name`    | the provider's name                                             |
| `region`  | its env vars and default region                                 |
| `busy`    | the cloud's error codes, each to a `Busy`                       |
| `distros` | each distro version's pointer to its newest image, per arch     |
| `presets` | each preset's types, per arch and size, newest generation first |
| `shapes`  | what `shape` reads: a type's vCPUs, memory, GPU and arch        |
| `tags`    | RIG's tag names the cloud cannot hold, each to one it can       |

## 5. Your Own

A provider is an object with the keys of the spec, §8 (`slot`, `name`, `rig`, `keys`, `distros`, `presets`), and the calls of §9, made by a factory that takes the config above; `can` names what it supports:

| `can`  | When `true`                                         |
| ------ | --------------------------------------------------- |
| `spot` | it sells spot                                       |
| `stop` | `start` and `stop` are there                        |
| `disk` | `disk.grow` and `disk.get` are there                |
| `port` | `port.open`, `port.close` and `port.list` are there |

The core gives it the helpers the official ones use:

| Helper              | Makes                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `createPresets`     | the five presets, from its type table                                                             |
| `createDistroTable` | its `distros`, and each version's pointer to its newest image                                     |
| `checkFactory`      | the check of its factory's config                                                                 |
| `regionOf`          | its region: the one given, else `RIG_<NAME>_REGION`, else its cloud's env var's, else its default |
| `createTagMap`      | its tag names, both ways, for a cloud that cannot hold RIG's                                      |

The kit, `spec/kit/`, plays the core against a fake provider; `test/` in the repo runs the same checks on every provider.
