# rig spec, generation 1

| Status | Generation | Scope                                   |
| ------ | ---------- | --------------------------------------- |
| draft  | 1          | core and providers; the hub is reserved |

## Abstract

Rig creates machines on cloud providers with **failover**: when a try finds no room, the core tries the next place, across zones, types, markets and providers.

On `spot`, a provider may take a machine back. The core estimates how often that happens per place, from each type's shape and its own counts, replaces lost machines, and warns about risky kinds when it opens.

This document defines the contract between a **core** and its **providers**. Any core and any provider that follow it work together, in any language.

## Contents

- Part 1 · Basics: 1 Conventions · 2 Terms · 3 Types · 4 Generation
- Part 2 · Config: 5 Config · 6 Kind · 7 Preset
- Part 3 · Provider: 8 Plugin · 9 Calls · 10 Shapes · 11 Rules · 12 Data file
- Part 4 · Core: 13 Tags · 14 Failover · 15 Risk · 16 Rounds · 17 Guard · 18 Events · 19 Refusals
- Part 5 · App: 20 Calls · 21 Kit
- Part 6 · Reserved: 22 Hub
- Appendix A · An aws data file

---

# Part 1 · Basics

## 1. Conventions

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to be read as in RFC 2119. A rule without one of them is a **MUST**.

Each term of §2 has one meaning in this document, and each thing has one term.

## 2. Terms

| Term          | Definition                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| **app**       | the program that runs a core                                                 |
| **core**      | the implementation of this spec inside the app                               |
| **store**     | the folder where the core keeps what it knows                                |
| **provider**  | a plugin for one cloud                                                       |
| **machine**   | one server a provider runs for the core                                      |
| **kind**      | a named recipe for machines                                                  |
| **entry**     | one item of a kind's `try` list: a provider, markets, types                  |
| **preset**    | a provider's ready recipe that makes a kind from a name                      |
| **market**    | how a machine is paid: `spot`, which the provider may take back, or `demand` |
| **take-back** | the provider ending a `spot` machine on its own                              |
| **place**     | a provider, market, type and zone where a machine could be created           |
| **try**       | one `create` call at one place                                               |
| **busy**      | the answer to a try that found no room                                       |
| **failover**  | trying the next place after a busy answer                                    |
| **lost**      | a machine that ended without the core ending it                              |
| **recover**   | a failover that replaces a lost machine                                      |
| **risk**      | the core's own estimate of how often a place's machines are taken back, §15  |
| **shape**     | a type's vCPUs, memory, GPU and CPU arch, from the provider's data           |
| **round**     | one pass of the core over its machines                                       |
| **guard**     | the risk checks the core runs on kinds when it opens                         |
| **refusal**   | the core declining a config, a plugin or a call                              |

Machine verbs: **create** (new) · **start** (power on) · **stop** (power off) · **reboot** · **end** (delete).

Core verbs: **open** (begin rounds) · **close** (end rounds). Neither touches a machine.

## 3. Types

| Type     | Definition                                                                         |
| -------- | ---------------------------------------------------------------------------------- |
| `str`    | a UTF-8 string                                                                     |
| `uint`   | a whole number ≥ 0                                                                 |
| `bool`   | `true` or `false`                                                                  |
| `ms`     | `uint`: unix time in milliseconds                                                  |
| `dur`    | `str`: a number and one of `s`, `m`, `h`, `d`: `"30s"`, `"10m"`; `"0"` means never |
| `pct`    | `str`: a number and `%`: `"10%"`                                                   |
| `name`   | `str` matching `[a-z][a-z0-9-]{0,31}`                                              |
| `market` | `"spot"` or `"demand"`                                                             |
| `busy`   | `"zone"`, `"type"`, `"market"` or `"account"`                                      |
| `status` | `"pending"`, `"running"`, `"stopping"`, `"stopped"`, `"ending"` or `"ended"`       |
| `[T]`    | a list of `T`, in order                                                            |
| `{K: T}` | a map from `K` to `T`, no order                                                    |
| `?T`     | optional `T`; absent means none                                                    |

Where the order of a list matters, this spec says so. An item of a list is named by its `name`.

## 4. Generation

A generation is a fixed contract. This is generation `1`.

| Where    | Rule                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| config   | `rig` MUST be `1`; otherwise a refusal: `config is for rig N, this is rig 1`       |
| plugins  | `rig` MUST be `1`; otherwise a refusal                                             |
| store    | the core MUST keep everything under `<store>/rig/1/`, and MUST NOT read outside it |
| machines | the core MUST NOT touch a machine whose `rig` tag is missing or not `1`            |

Within a generation, a change MUST only add: an optional key, a field, a busy code, a preset, a guard check, an event. Any other change is a new generation.

---

# Part 2 · Config

## 5. Config

| Key         | Type                   | Default    | Definition                                      |
| ----------- | ---------------------- | ---------- | ----------------------------------------------- |
| `rig`       | `uint`                 | —          | the generation: `1`                             |
| `app`       | `name`                 | —          | this app's name, §13                            |
| `providers` | `[provider]`           | —          | at least one                                    |
| `kinds`     | `[kind]`               | —          | at least one                                    |
| `guard`     | `"warn"` or `"refuse"` | `"warn"`   | §17                                             |
| `every`     | `dur`                  | `"30s"`    | time between rounds, §16; `"0"`: only `round()` |
| `poll`      | `dur`                  | `"5s"`     | time between polls of a wait, §20; not `"0"`    |
| `store`     | `str`                  | `"./.rig"` | a folder; the core uses `<store>/rig/1/`        |
| `extra`     | `?{str: any}`          | —          | the lib's own settings, as the lib defines them |

When the core opens, each of these MUST be a refusal, `config`, naming the key by path (`kinds[worker].try[0].types`):

- a key unknown, missing, or of the wrong type;
- two kinds with one `name` (two providers with one `name` fail §8 first);
- an entry whose `provider` is not in `providers`;
- `spot` in an entry's `market`, its provider without `can.spot`;
- a kind tag whose key starts with `rig`;
- a reserved key, §22.

## 6. Kind

| Key        | Type            | Default | Definition                                            |
| ---------- | --------------- | ------- | ----------------------------------------------------- |
| `name`     | `name`          | —       | unique among kinds                                    |
| `try`      | `[entry]`       | —       | where to try, in order; at least one                  |
| `image`    | `?str`          | —       | for every entry without its own                       |
| `disk`     | `?uint`         | —       | GB of the boot disk                                   |
| `script`   | `?str`          | —       | a startup script                                      |
| `risk`     | `?{ max: pct }` | —       | §15                                                   |
| `life`     | `?dur`          | never   | the core ends the machine after this                  |
| `recovers` | `?uint`         | `3`     | how many recovers a lost machine may have; `0` = none |
| `tags`     | `?{str: str}`   | —       | the app's own tags; no key may start with `rig`       |

**entry**

| Key        | Type          | Definition                                |
| ---------- | ------------- | ----------------------------------------- |
| `provider` | `name`        | the `name` of a provider in `providers`   |
| `market`   | `[market]`    | in order; at least one; no repeats        |
| `types`    | `[str]`       | best first; at least one                  |
| `image`    | `?str`        | the provider's image id                   |
| `extra`    | `?{str: any}` | provider-specific, passed as `spec.extra` |

`market` is always a list, even with one market: `["demand"]`.

## 7. Preset

A preset makes a kind from a `name` and a few options, so the app needs to know no type names. Every provider MUST offer every preset below. The core sees the kind a preset returns.

### 7.1 Presets

| Preset    | For                     | Size option | Default size            | Default `market`     |
| --------- | ----------------------- | ----------- | ----------------------- | -------------------- |
| `small`   | a light, long-lived box | —           | —                       | `["demand"]`         |
| `general` | balanced cpu and memory | `cpu`       | `2`                     | `["demand"]`         |
| `compute` | cpu-heavy work          | `cpu`       | `4`                     | `["spot", "demand"]` |
| `memory`  | memory-heavy work       | `mem`       | `32`                    | `["demand"]`         |
| `gpu`     | gpu work                | `gpu`       | the provider's cheapest | `["spot", "demand"]` |

### 7.2 Options

Only `name` is required.

| Option    | Type                           | Default                                              | Definition                                                                                  |
| --------- | ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `name`    | `name`                         | —                                                    | the kind's name                                                                             |
| `cpu`     | `?uint`                        | per preset                                           | vCPUs; `general`, `compute`                                                                 |
| `mem`     | `?uint`                        | per preset                                           | GB of memory; `memory`                                                                      |
| `gpu`     | `?str`                         | per preset                                           | the GPU model: `"l4"`, `"a10"`, `"h100"`; `gpu`                                             |
| `market`  | `?[market]`                    | per preset                                           |                                                                                             |
| `arch`    | `?"arm"`, `?"x86"` or `?"any"` | `"any"`; with `image`, `"arm"` if sold, else `"x86"` | the CPU architecture; `"any"` is `arm`'s types, then `x86`'s                                |
| `up`      | `?uint`                        | `0`                                                  | also try the next `up` sizes, after every type of the asked size; not `small`, not `gpu`    |
| kind keys | —                              | —                                                    | `image`, `disk`, `script`, `risk`, `life`, `recovers`, `tags`: passed to the kind unchanged |

### 7.3 Rules

- A preset MUST return a kind with one entry: this provider, `market` as given, `types` from the data file (§12).
- A size not sold MUST round up to the next size that is.
- `arch: "any"` with `image` MUST be a refusal, `config`: an image fits one arch.
- Each type MUST appear once, the first time it is reached.
- An option the preset does not take (`mem` on `compute`) MUST be a refusal: `config`.
- A preset without `name` MUST be a refusal: `config`.
- A preset MUST NOT call the provider.
- How a lib shows presets is its own choice. It SHOULD put them next to the provider, so they are found at once.

```
compute { name: "worker", cpu: 8 }
  →
{ name: "worker",
  try: [{ provider: "aws", market: ["spot", "demand"], types: ["c8g.2xlarge", "c7g.2xlarge", "c6g.2xlarge"] }] }
```

---

# Part 3 · Provider

## 8. Plugin

A provider is a plugin: one object with these keys.

| Key       | Type           | Definition                                      |
| --------- | -------------- | ----------------------------------------------- |
| `slot`    | `"provider"`   | the slot it fills; `"hub"` is reserved, §22     |
| `name`    | `name`         | how entries refer to it; unique among providers |
| `rig`     | `uint`         | the generation it follows                       |
| `can`     | `?{str: bool}` | what it supports, below                         |
| `keys`    | `[str]`        | the key names its `auth` takes, §8.1            |
| `presets` | functions      | §7                                              |
| calls     | functions      | §9                                              |

| `can`  | When `true`                                           | When `false` or absent                         |
| ------ | ----------------------------------------------------- | ---------------------------------------------- |
| `spot` | the provider sells `spot`                             | `spot` in an entry for it is a refusal, §5     |
| `stop` | `start` and `stop` are present                        | `start` and `stop` are refusals: `unsupported` |
| `disk` | `disk.grow` and `disk.get` are present                | the `disk` calls are refusals: `unsupported`   |
| `port` | `port.open`, `port.close` and `port.list` are present | the `port` calls are refusals: `unsupported`   |

When the core opens, it MUST check every plugin in this order, and the first failure MUST be a refusal, `plugin`, unless named:

1. `rig` is `1`; otherwise `generation`, §4.
2. `slot` is `"provider"`; `"hub"` is a refusal, `config`, §22.
3. `name` is a `name`, not taken.
4. Every call that is always present is there, and every call that `can` enables.
5. If the provider has `check`, the core calls it: a throw is a refusal, `plugin`.

The core MUST NOT list, create or end a machine before every plugin passes.

### 8.1 Auth

Every provider takes the same `auth` option, so the app signs in the same way on every cloud. Each provider implements it in its own package, and `auth` stays inside the provider.

| `auth`                               | Signs in with                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `{ from: "auto" }`, the default      | whatever the environment already has: the cloud's own env vars, login, or machine identity |
| `{ from: "env", prefix?: str }`      | keys from env vars `<prefix>_<KEY>`; `prefix` defaults to `RIG_<NAME>`                     |
| `{ from: "keys", keys: {str: str} }` | keys passed in                                                                             |

- A provider MUST name its keys on the plugin: `keys: ["id", "secret", "token?"]`; `?` marks an optional key.
- `<NAME>` and `<KEY>` are upper case, `-` as `_`: provider `aws-east`, key `id` → `RIG_AWS_EAST_ID`.
- With `env` or `keys`, every key without `?` MUST be there, and no key the provider does not name: otherwise a refusal, `plugin`.
- A provider MUST resolve its `auth` when it is made, and its `check` (§9) proves the keys work when the core opens.
- No secret MAY appear in the store, an event, a log, or an error: a refusal names the key, never its value.

### 8.2 Factory

A provider is made by a **factory**: one call that takes the provider's config and gives the plugin. Every provider's factory takes the same config, so changing cloud only changes `extra`.

| Key        | Type          | Default            | Definition                                                |
| ---------- | ------------- | ------------------ | --------------------------------------------------------- |
| `region`   | `str`         | —                  | where its machines go, by the provider's own name for it  |
| `name`     | `?name`       | the cloud's own    | its name in the config, §8; two regions are two providers |
| `auth`     | `?auth`       | `{ from: "auto" }` | how it signs in, §8.1                                     |
| `identity` | `?str`        | none               | what its machines run as: a role, a service account       |
| `extra`    | `?{str: any}` | —                  | the provider's own settings, as the provider defines them |

- A factory MUST refuse, `config`, a key outside this table: anything of the provider's own goes in `extra`.
- It gives the plugin of §8, with `keys` (§8.1), `presets` (§7) and, if it has one, `shape` (§9).
- A lib SHOULD name its factories alike, and the core's with them: in TypeScript, `createRig` and `createAws`, `createGcp`.

## 9. Calls

Every call is asynchronous. A failure §11 does not define MUST throw. The core passes a throw to the app.

| Call         | Input                  | Output                      | Present    |
| ------------ | ---------------------- | --------------------------- | ---------- |
| `places`     | `entry`                | `[place]`                   | always     |
| `create`     | `place`, `spec`        | `answer`                    | always     |
| `get`        | `id: str`              | `?machine`                  | always     |
| `list`       | `tags: {str: str}`     | `[machine]`                 | always     |
| `end`        | `id: str`              | —                           | always     |
| `reboot`     | `id: str`              | —                           | always     |
| `check`      | —                      | —                           | optional   |
| `shape`      | `type: str`            | `?shape`                    | optional   |
| `start`      | `id: str`              | —                           | `can.stop` |
| `stop`       | `id: str`              | —                           | `can.stop` |
| `disk.grow`  | `id: str`, `gb: uint`  | —                           | `can.disk` |
| `disk.get`   | `id: str`              | `{ gb: uint, ready: bool }` | `can.disk` |
| `port.open`  | `id: str`, `rule`      | `rule`, with its `id`       | `can.port` |
| `port.close` | `id: str`, `rule: str` | —                           | `can.port` |
| `port.list`  | `id: str`              | `[rule]`                    | `can.port` |

## 10. Shapes

**place**

| Key      | Type     | Definition                                          |
| -------- | -------- | --------------------------------------------------- |
| `market` | `market` |                                                     |
| `type`   | `str`    | the provider's type name                            |
| `zone`   | `str`    | the provider's zone name                            |
| `price`  | `?str`   | per hour, with currency: `"0.0412 USD"`; for people |

**spec**: filled by the core.

| Key      | Type          | Definition                                            |
| -------- | ------------- | ----------------------------------------------------- |
| `name`   | `str`         | `<app>-<kind>-<8 lowercase hex>`                      |
| `image`  | `?str`        | the image id; absent → the provider's default         |
| `disk`   | `?uint`       | GB of the boot disk; absent → the provider's default  |
| `script` | `?str`        | a startup script, plain text; the provider encodes it |
| `tags`   | `{str: str}`  | the rig tags and the kind's own, §13                  |
| `extra`  | `?{str: any}` | the entry's `extra`, unchanged                        |

**answer**: exactly one of:

| Answer                          | Definition                 |
| ------------------------------- | -------------------------- |
| `{ ok: { id: str } }`           | a machine is being created |
| `{ busy: busy, message?: str }` | no room, §11               |

**machine**

| Key       | Type                               | Definition                     |
| --------- | ---------------------------------- | ------------------------------ |
| `id`      | `str`                              | unique within the provider     |
| `status`  | `status`                           | mapped from the provider's own |
| `market`  | `market`                           |                                |
| `type`    | `str`                              |                                |
| `zone`    | `str`                              |                                |
| `tags`    | `{str: str}`                       | every tag on the machine       |
| `ip`      | `?{ public?: str, private?: str }` |                                |
| `created` | `ms`                               |                                |

**shape**: a type, as §15 sees it.

| Key    | Type               | Definition                    |
| ------ | ------------------ | ----------------------------- |
| `cpu`  | `uint`             | vCPUs                         |
| `mem`  | `uint`             | GB of memory                  |
| `gpu`  | `?str`             | the GPU model: `"l4"`, `"t4"` |
| `arch` | `"arm"` or `"x86"` | the CPU architecture          |

**rule**

| Key     | Type    | Definition                           |
| ------- | ------- | ------------------------------------ |
| `id`    | `?str`  | the provider's id; set on output     |
| `port`  | `uint`  | the port, or the first of a range    |
| `to`    | `?uint` | the last port of a range             |
| `proto` | `?str`  | `"tcp"` or `"udp"`; absent → `"tcp"` |
| `from`  | `str`   | a CIDR: `"1.2.3.4/32"`               |

## 11. Rules

| Call     | Rule                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `places` | MUST return only places sold now for the entry's markets and types, in any order                                                |
| `create` | MUST make exactly one try: no second try, no other place                                                                        |
| `create` | MUST put every tag of `spec.tags` on the machine as it is created, or throw; `spec.extra` MUST NOT change that, nor the one try |
| `create` | MUST answer `busy` only when there is no room, with the code below; else MUST throw                                             |
| `check`  | MUST throw when the provider cannot work: wrong keys, no access, an unknown region                                              |
| `shape`  | MUST come from the provider's own data, never from a call to the cloud; a type it does not know is `null`                       |
| `get`    | an unknown id MUST give `null`, not throw                                                                                       |
| `list`   | MUST return every machine with all the given tags, in every status but `ended`, all pages                                       |
| `end`    | an unknown or ended id MUST succeed, and still remove what that machine left                                                    |
| `end`    | MUST also remove what the machine leaves: its port rules, its unattached disks                                                  |
| `stop`   | on a `spot` machine MUST be a refusal: `unsupported`                                                                            |
| status   | MUST map the provider's own statuses onto `status`; after a take-back, `ended`                                                  |

| `busy`    | No room                                  |
| --------- | ---------------------------------------- |
| `zone`    | for this type in this zone               |
| `type`    | for this type anywhere in this entry     |
| `market`  | in this market: price, or a market limit |
| `account` | in this account: a quota                 |

## 12. Data file

A provider MUST keep what is not code in a data file (Appendix A), so that providers for the same cloud in different languages agree.

| Key       | Definition                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rig`     | the generation                                                                                                                                           |
| `name`    | the provider's name                                                                                                                                      |
| `busy`    | the provider's error code → `busy`; a code not listed MUST throw                                                                                         |
| `tags`    | tag names the provider cannot hold → names it can: `{ "rig-app": "rig_app" }`; the provider MUST map them both ways, so the core only sees its own names |
| `presets` | preset → arch → size → types; `small` has no size: arch → types                                                                                          |
| `shapes`  | what `shape` reads; its form is the provider's own                                                                                                       |

- Types MUST be listed best first: newest generation first, older ones as fallback.
- The first size listed is the default, unless §7.1 sets one. For `gpu`, the first model listed is the cheapest.

---

# Part 4 · Core

## 13. Tags

Every machine the core creates MUST carry:

| Tag        | Value              |
| ---------- | ------------------ |
| `rig`      | `1`                |
| `rig-app`  | the config's `app` |
| `rig-kind` | the kind's name    |
| `rig-name` | `spec.name`        |

The kind's own `tags` MUST be on the machine too. A rig tag wins over a kind tag of the same name; §5 refuses those anyway.

- The core MUST find its machines with `list({ "rig": "1", "rig-app": app })` on every provider, and MUST still drop any machine `list` gives without both tags.
- The core MUST NOT end, recover or count a machine of another app.

## 14. Failover

The core MUST try places in this order, and stop at the first `ok`:

```
for entry in kind.try:
    places = provider(entry).places(entry)
    remove places above kind.risk.max                           (§15)
    for market in entry.market:
        for type in entry.types:
            for place in places of this market and type, sorted by zone:
                answer = provider(entry).create(place, spec)
                ok            → return the machine
                busy zone     → next place
                busy type     → next type
                busy market   → next market
                busy account  → next entry
                throw         → pass the throw to the app
return null
```

- The core MUST call an entry's `places` only when the failover reaches that entry.
- A type that `places` does not return MUST be skipped without a try.
- Zones MUST be sorted by name, so every failover follows the same order.
- The core MUST NOT try a place twice in one failover.
- The core MUST emit `try` after every try.

## 15. Risk

Risk is the core's own estimate of how often a place's machines are taken back, as a percent a month. It needs nothing from a provider but each type's shape (§9), and the core's own counts. Every core MUST compute it the same way, with the constants below.

### 15.1 Counts

The core MUST keep, per place, in `<store>/rig/1/risk.json`, written after every change: a map from `<provider>/<market>/<type>/<zone>` to `seen`.

| Key       | Type   | Counts                                                                       |
| --------- | ------ | ---------------------------------------------------------------------------- |
| `tries`   | `uint` | tries at the place                                                           |
| `busy`    | `uint` | of those, `busy` answers                                                     |
| `created` | `uint` | machines created at the place                                                |
| `lost`    | `uint` | of those, lost; a machine the core ends MUST NOT count                       |
| `hours`   | `uint` | the hours machines ran at the place, counted when each leaves: lost or ended |

```json
{ "aws/spot/c8g.2xlarge/us-east-1a": { "tries": 52, "busy": 12, "created": 40, "lost": 3, "hours": 2190 } }
```

### 15.2 Prior

Before the core has seen a place, its risk is a **prior**, from the type's shape. A `demand` place's prior is `0`. A `spot` place's:

```
base    = 25  with a gpu
        =  5  with 2 vCPU or fewer
        =  8  else
size    = 1   up to 4 vCPU
        = 1.25  up to 16
        = 1.5   up to 48
        = 2     more
arch    = 0.8 on arm, 1 else
prior   = min(50, base × size × arch)
```

A type with no shape (the provider gives none) is `base 8`, `size 1`, `arch 1`: `8`.

### 15.3 Estimate

```
pressure = busy ÷ (tries + 5)                                  a place often full is more likely taken back
months   = (hours + the hours the place's running machines have run so far) ÷ 730
p        = min(50, prior × (1 + pressure)) ÷ 100
takeback = 100 × (lost + p × 2) ÷ (months + 2)                 2 machine-months of the prior, fading as months grow
```

- `takeback` MUST be rounded to one decimal; `pressure` is shown as a percent, `100 × pressure`, rounded the same.
- With no counts, `takeback` is the prior. After a few machine-months, the counts lead.
- **risk** is `{ takeback, pressure, prior, seen }`.
- `risk.max` removes a place when its `takeback` is above `max`.

## 16. Rounds

**Open**, in order: generation (§4), plugins (§8), config (§5), guard (§17), the store, the first round. The first round adopts every machine of this app.

**Close**: end the rounds, write the store. The core MUST NOT end a machine when it closes.

**A round**: every `every`, the core MUST list its machines (§13) and compare them with the store. For each machine still running, the core MUST copy its `status` and `ip` into the store.

- One round MUST run at a time; a round asked for while one runs is that round.
- A round MUST judge only the machines the store held before it listed: a machine made meanwhile is never lost in it.

| Seen                                                       | Is         | The core MUST                                                                                  |
| ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| in the store, now `ended` or absent, not ended by the core | **lost**   | count it (§15), `end` it so the provider removes what it left, emit `machine:lost`, recover it |
| in the store, ended by the core                            | **ended**  | remove it from the store                                                                       |
| in the store, older than its kind's `life`                 | **old**    | end it, emit `machine:ended`                                                                   |
| not in the store, its kind in the config                   | **found**  | add it to the store                                                                            |
| not in the store, its kind not in the config               | **orphan** | emit `machine:orphan`; MUST NOT end it                                                         |

**Recover**: a failover (§14) for the lost machine's kind, from its first entry.

| Result           | The core MUST                          |
| ---------------- | -------------------------------------- |
| `ok`             | emit `machine:recovered`               |
| `null`           | recover again the next round           |
| `recovers` spent | stop recovering, emit `machine:failed` |

- `recovers` counts the replacements made along a chain: a lost machine, its replacement, the replacement's replacement. A `null` result does not count.
- With `recovers: 0`, a lost machine is never replaced: `machine:lost`, then `machine:failed`.
- A recover emits `try` for each try and `machine:recovered`, not `machine:created`.

## 17. Guard

When the core opens, it MUST check every kind for risk. Each code MUST be emitted at most once per kind, as `guard`, and MUST be a refusal when `guard` is `"refuse"`.

| Code          | When                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `spot-warn`   | `spot` in any entry's `market`: nothing warns before a take-back, so its data is lost                  |
| `spot-long`   | `spot` in any entry's `market`, no `life`, and a spot place whose `takeback` is above `10`             |
| `spot-narrow` | `spot` in any entry's `market`, and fewer than `3` spot places in all: one busy pool can take them all |

Until the hub (§22) defines a warning before a take-back, `spot-warn` holds for every kind with `spot`.

## 18. Events

| Event               | Data                      | When                                            |
| ------------------- | ------------------------- | ----------------------------------------------- |
| `try`               | `{ kind, place, answer }` | after every try; a throw is `answer: { error }` |
| `machine:created`   | `{ machine }`             | `machine.create` gave a machine                 |
| `machine:ended`     | `{ machine }`             | the core ended a machine                        |
| `machine:lost`      | `{ machine }`             | §16                                             |
| `machine:recovered` | `{ lost, machine }`       | a recover gave a machine                        |
| `machine:failed`    | `{ machine, recovers }`   | lost, with `recovers` spent                     |
| `machine:orphan`    | `{ machine }`             | §16                                             |
| `guard`             | `{ kind, code }`          | §17                                             |

An event MUST be emitted only after the change it reports is in the store.

## 19. Refusals

| Reason        | When                                        |
| ------------- | ------------------------------------------- |
| `generation`  | the config or a plugin is not `rig: 1`, §4  |
| `plugin`      | a plugin fails §8                           |
| `config`      | the config fails §5, or a preset fails §7   |
| `guard`       | a guard finding with `guard: "refuse"`, §17 |
| `unsupported` | a call the provider's `can` does not enable |
| `unknown`     | a machine id the store does not hold, §20   |
| `closed`      | a call before `open` or after `close`, §20  |
| `timeout`     | a wait past its `timeout`, §20              |

A refusal carries `reason` and `message`. Code MUST read only `reason`; `message` is for people.

---

# Part 5 · App

## 20. Calls

What the app calls on the core. A lib MAY name them in its own style (`machine.create`, `machine_create`), but MUST keep their meaning.

| Call             | Input                                | Output          | Does                                                                                                             |
| ---------------- | ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `open`           | —                                    | —               | §16                                                                                                              |
| `close`          | —                                    | —               | §16                                                                                                              |
| `round`          | —                                    | —               | runs a round now, §16                                                                                            |
| `on`             | `event: str`, a handler              | —               | calls the handler on every such event, §18                                                                       |
| `place.list`     | `kind: name`                         | `[place]`       | the places a failover would try, in its order, each with `provider` and `risk`; its length is the kind's breadth |
| `machine.create` | `kind: name`                         | `?machine`      | a failover, §14; `null` when there is no room                                                                    |
| `machine.get`    | `id: str`                            | `?machine`      | the provider's `get`, copied into the store; `null` for an id the store does not hold                            |
| `machine.wait`   | `id: str`, `status`, `?timeout: dur` | `machine`       | `machine.get` every `poll`, until the machine has `status`, or is `ended`                                        |
| `machine.list`   | `?{ kind?: name }`                   | `[machine]`     | from the store                                                                                                   |
| `machine.end`    | `id: str`                            | —               | the provider's `end`; emits `machine:ended`                                                                      |
| `machine.start`  | `id: str`                            | —               | the provider's `start`                                                                                           |
| `machine.stop`   | `id: str`                            | —               | the provider's `stop`                                                                                            |
| `machine.reboot` | `id: str`                            | —               | the provider's `reboot`                                                                                          |
| `disk.grow`      | `id: str`, `gb: uint`                | —               | the provider's                                                                                                   |
| `disk.get`       | `id: str`                            | `{ gb, ready }` | the provider's                                                                                                   |
| `disk.wait`      | `id: str`, `?timeout: dur`           | `{ gb, ready }` | `disk.get` every `poll`, until `ready`                                                                           |
| `port.open`      | `id: str`, `rule`                    | `rule`          | the provider's                                                                                                   |
| `port.close`     | `id: str`, `rule: str`               | —               | the provider's                                                                                                   |
| `port.list`      | `id: str`                            | `[rule]`        | the provider's                                                                                                   |

- Every call but `open` and `on` MUST be a refusal before `open`, and after `close`: `closed`.
- `on` MAY be called before `open`, so the app hears `guard` while the core opens.
- A call with a machine id the store does not hold MUST be a refusal: `unknown`; `machine.get` gives `null` instead.
- A kind name not in the config MUST be a refusal: `config`; so is a `status` that is not a `status`, and a `timeout` that is not a `dur`.
- A wait whose machine leaves the store (a round found it lost) MUST end with that machine, `status: "ended"`.
- A wait MUST check once before its first `poll`, and MUST be a refusal, `timeout`, when `timeout` (default `"10m"`) has passed since it began.
- A machine the provider no longer has comes back from `machine.get` with `status: "ended"`. The round that follows finds it lost, §16.
- The machine the app sees is the provider's `machine` (§10) with three more keys: `provider`, `kind` and `name`.

## 21. Kit

The kit, in `spec/kit/`, proves that a core follows this spec. It is data: each file holds cases, in the format of `spec/kit/schema.json`, that a lib plays against its core with a fake provider. `spec/kit/README.md` says how.

A core that passes every case MAY say it follows rig generation 1.

---

# Part 6 · Reserved

## 22. Hub

A later minor of generation 1 defines the `hub`: jobs on machines, a warning before a take-back, and keeping a job's files. The hub speaks **grid** (`grid/2`, defined by grid's own spec) to its machines; this spec will refer to grid's spec, not repeat it.

Until then, each of these MUST be a refusal, `config`:

- the config key `hub`;
- the kind keys `node` and `save`;
- a plugin with `slot: "hub"`.

---

# Appendix A · An aws data file

A part of `packages/aws/src/aws.json`, the official aws provider's data file.

```json
{
    "rig": 1,
    "name": "aws",
    "busy": {
        "InsufficientInstanceCapacity": "zone",
        "InsufficientHostCapacity": "zone",
        "InsufficientFreeAddressesInSubnet": "zone",
        "Unsupported": "zone",
        "SpotMaxPriceTooLow": "market",
        "MaxSpotInstanceCountExceeded": "market",
        "InstanceLimitExceeded": "account",
        "VcpuLimitExceeded": "account"
    },
    "tags": {},
    "presets": {
        "small": {
            "arm": ["t4g.small", "t4g.medium"],
            "x86": ["t3.small", "t3a.small", "t3.medium", "t3a.medium"]
        },
        "compute": {
            "arm": {
                "4": ["c8g.xlarge", "c7g.xlarge", "c7gn.xlarge", "c6g.xlarge", "c6gn.xlarge"]
            },
            "x86": {
                "4": ["c7i.xlarge", "c7a.xlarge", "c6i.xlarge", "c6a.xlarge", "c5.xlarge"]
            }
        }
    },
    "shapes": {
        "memory": {
            "c": 2,
            "m": 4,
            "r": 8,
            "x": 16,
            "z": 8,
            "i": 8,
            "d": 8,
            "h": 4
        },
        "families": {
            "g5g": {
                "memory": 2,
                "gpu": "t4"
            },
            "g6": {
                "memory": 4,
                "gpu": "l4"
            }
        },
        "burstable": {
            "small": {
                "cpu": 2,
                "mem": 2
            },
            "medium": {
                "cpu": 2,
                "mem": 4
            }
        }
    }
}
```
