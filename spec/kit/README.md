# RIG kit, generation 1

The conformance suite for the RIG spec. It is data: each file holds **cases** that a lib plays against its own core, with a **fake provider** in place of a cloud.

A core that passes every case MAY say it follows RIG generation 1.

## 1. Files

| File            | Area                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.json`   | the JSON Schema of every kit file                                                                                                    |
| `open.json`     | generation, plugins, config, distros, login, script, disk, workers, closed calls                                                     |
| `failover.json` | the order of tries, every busy answer, a throw, no room, a place tried once                                                          |
| `risk.json`     | `risk.max`, the core's own count, `place.list`                                                                                       |
| `rounds.json`   | lost, recover, `recovers`, `life`, found, orphan, close                                                                              |
| `guard.json`    | `spot-warn`, `spot-long`, `spot-narrow`, `guard: "refuse"`                                                                           |
| `calls.json`    | the app's calls: machines, filters, lost machines, create options, disks, ports, first boot, workers; unknown ids, unsupported calls |

```json
{
    "$schema": "./schema.json",
    "rig": 1,
    "area": "failover",
    "description": "...",
    "cases": [
        {
            "id": "failover/busy-zone",
            "description": "busy zone tries the next zone",
            "given": { "config": {}, "fake": {}, "store": {} },
            "steps": [{ "do": "open" }, { "do": "call", "call": "machine.create", "args": ["w"], "expect": {} }]
        }
    ]
}
```

- `id` is `<area>/<name>`: stable, unique across the kit. A case is never renamed; a wrong case is fixed in place.
- A runner SHOULD validate each file against `schema.json` before it runs it.

## 2. Given

| Key      | Is                                                                     |
| -------- | ---------------------------------------------------------------------- |
| `config` | the core's config, §3 for its providers                                |
| `fake`   | what each fake provider holds, by provider name, §3                    |
| `store`  | optional: what the store holds before the first step: `{ "risk": {} }` |

For each case, the runner MUST start a new core, an empty store (then `given.store`), and a clock at `0`.

## 3. The fake provider

In `config.providers`, each provider is written as data:

```json
{ "name": "a", "can": { "spot": true, "stop": true } }
```

`rig` is `1` unless given. `distros` is every distro version of the spec's §6.1 unless given: `"distros": { "ubuntu": ["24.04"] }`. The runner MUST turn it into a fake provider that follows the spec's provider rules, with every call that `can` enables and no other. With `"check": "fail"`, the fake has a `check` that throws; with `"check": "ok"`, one that passes; absent, no `check`.

`fake.<name>`:

| Key        | Is                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------- |
| `places`   | every place it sells; `places(entry)` returns those of the entry's markets and types     |
| `answers`  | `"<market>/<type>/<zone>"` → an answer, or a list of answers given in turn, one per try  |
| `machines` | optional: machines it runs before the first step                                         |
| `boot`     | optional: how many `get` calls a new machine stays `pending` before it is `running`; `0` |

| Answer          | The fake                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| `"ok"`          | answers `{ ok: { id } }`, with the next id across all fakes: `m1`, `m2`, ... |
| `"busy <code>"` | answers `{ busy: "<code>" }`                                                 |
| `"throw"`       | throws                                                                       |

- A try at a place with no answer left MUST fail the case: the core tried what it should not.
- After `ok`, the fake runs the machine: `status: "running"` (or `"pending"`, with `boot`), the place's market, type and zone, `image`: `spec.image`, or `"<name>-<version>"` from `spec.distro`, `spec.tags`, `ip: { private: "10.0.0.<n>" }` for id `m<n>`, `created` at the clock.
- With `can.disk`, every machine has a disk of `30` GB: `disk.grow` sets its size, `disk.get` gives `{ gb, ready: true }`.
- With `can.port`, a new machine starts with `spec.ports` as its rules, each with the next id, and every machine keeps its rules: `port.open` adds one with the next id across all fakes, `r1`, `r2`, ...; `port.close` removes it; `port.list` gives them, in order.
- Every `ok` try keeps its `spec.script` in the fake's `scripts`, in order; `null` without one.
- `end` makes a machine `ended`, and is kept in the fake's `ends`, in order. `list` never returns an `ended` machine.
- The config's `workers`, when it has them, are written as data too: `[{ "name": "g" }]`, with `slot: "worker"` and `rig: 1` unless given. The runner MUST turn each into a fake worker: its `check` refuses a kind's `worker` with `"refuse": true`; its `setup` gives `script: ["echo worker"]`, the worker's `ports` (by default `[{ "port": 9420, "from": "203.0.113.9/32" }]`), and `key: "key-<n>"` for its n-th `setup` call, a busy try's too (`"trial"` for the core's trial name, `<app>-<kind>-00000000`); with `"fails": n`, its first n `add`s throw; with `"missing": "<call>"`, it has not that call; with `"open": "fail"`, its `open` throws. It keeps each `add`, as given, in its `adds`, each `drop` as `{ name }` in its `drops`, and each `spent`'s tags in its `spents`, in order.
- `get` and `list` MUST return copies, as a real provider does: a later change in the fake MUST NOT show through what the core already holds.

## 4. Steps

| `do`        | With           | The runner                                          |
| ----------- | -------------- | --------------------------------------------------- |
| `open`      | —              | calls `open`                                        |
| `close`     | —              | calls `close`                                       |
| `round`     | `during`?      | calls `round`                                       |
| `call`      | `call`, `args` | calls that app call: `"machine.create"`, `["w"]`    |
| `take-back` | `id`           | the fake makes that machine `ended`, as a take-back |
| `clock`     | `by`           | moves the clock forward by a `dur`: `"3h"`          |
| `ip`        | `id`, `ip`     | the fake gives that machine these IPs from now on   |

With `during`: `{ "call": "machine.end", "args": ["m1"] }`, the runner makes that app call while the round's first `list` is in flight: once the call is done, that `list` gives its answer. The step's events are the call's, then the round's.

The runner MUST register a handler with `on` for every event before the first step, and collect the events of each step.

## 5. Expect

| Key       | Passes when                                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| `result`  | the call's result matches, §6                                                           |
| `refusal` | the step is a refusal with this `reason`                                                |
| `throws`  | `true`: the step throws, and is not a refusal                                           |
| `events`  | the step's events match in order, with none more and none fewer, §6                     |
| `store`   | the store matches: `{ "risk": {} }`                                                     |
| `fake`    | the fakes match: `{ "a": { "machines": [] } }`                                          |
| `workers` | each fake worker matches, by name: `{ "g": { "adds": [], "drops": [], "spents": [] } }` |

- A key absent from `expect` is not checked.
- A step without `refusal` or `throws` MUST NOT refuse or throw.

## 6. Matching

- An object matches when every key it has matches; other keys are not checked.
- A list matches when it has the same length, and each item matches in order.
- Any other value matches when it is equal. `null` matches only `null`.

An event is matched as `{ "event": "<name>", ...data }`. A `try` event is written short:

```json
{ "event": "try", "kind": "w", "place": "a/spot/t1/za", "answer": "busy zone" }
```

`place` is `<provider>/<market>/<type>/<zone>`; `answer` is as in §3.

## 7. Running

A runner reads every file, builds the fakes, plays the steps and matches. A lib SHOULD run the whole kit in its own tests, on every change. The core MUST let the runner set its clock, and its sleep between polls: a sleep moves the clock forward by its length, at once. How is the lib's choice.

A runner reports one line per case: its `id`, and `pass` or `fail` with the first mismatch.
