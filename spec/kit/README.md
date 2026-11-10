# rig kit, generation 1

The conformance suite for the rig spec. It is data: each file holds **cases** that a lib plays against its own core, with a **fake provider** in place of a cloud.

A core that passes every case MAY say it follows rig generation 1.

## 1. Files

| File            | Area                                                    |
| --------------- | ------------------------------------------------------- |
| `schema.json`   | the JSON Schema of every kit file                       |
| `open.json`     | generation, plugins, config, closed calls               |
| `failover.json` | the order of tries, every busy answer, a throw, no room |
| `risk.json`     | `risk.max`, the core's own count, `place.list`          |
| `rounds.json`   | lost, recover, `recovers`, `life`, found, orphan, close |
| `guard.json`    | `spot-warn`, `spot-long`, `guard: "refuse"`             |
| `calls.json`    | the app's calls: unknown ids, unsupported calls         |

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

`rig` is `1` unless given. The runner MUST turn it into a fake provider that follows the spec's provider rules, with every call that `can` enables and no other. With `"check": "fail"`, the fake has a `check` that throws; with `"check": "ok"`, one that passes; absent, no `check`.

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
- After `ok`, the fake runs the machine: `status: "running"` (or `"pending"`, with `boot`), the place's market, type and zone, `spec.tags`, `ip: { private: "10.0.0.<n>" }` for id `m<n>`, `created` at the clock.
- With `can.disk`, every machine has a disk of `30` GB: `disk.grow` sets its size, `disk.get` gives `{ gb, ready: true }`.
- `end` makes a machine `ended`. `list` never returns an `ended` machine.
- `get` and `list` MUST return copies, as a real provider does: a later change in the fake MUST NOT show through what the core already holds.

## 4. Steps

| `do`        | With           | The runner                                          |
| ----------- | -------------- | --------------------------------------------------- |
| `open`      | —              | calls `open`                                        |
| `close`     | —              | calls `close`                                       |
| `round`     | —              | calls `round`                                       |
| `call`      | `call`, `args` | calls that app call: `"machine.create"`, `["w"]`    |
| `take-back` | `id`           | the fake makes that machine `ended`, as a take-back |
| `clock`     | `by`           | moves the clock forward by a `dur`: `"3h"`          |

The runner MUST register a handler with `on` for every event before the first step, and collect the events of each step.

## 5. Expect

| Key       | Passes when                                                         |
| --------- | ------------------------------------------------------------------- |
| `result`  | the call's result matches, §6                                       |
| `refusal` | the step is a refusal with this `reason`                            |
| `throws`  | `true`: the step throws, and is not a refusal                       |
| `events`  | the step's events match in order, with none more and none fewer, §6 |
| `store`   | the store matches: `{ "risk": {} }`                                 |
| `fake`    | the fakes match: `{ "a": { "machines": [] } }`                      |

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
