# Failover

> When a try finds no room, the next place; when a machine is lost, a new one

A **place** is a provider, a market, a type and a zone where a machine could be created. A **try** is one `create` at one place. The core tries a kind's places in order, and stops at the first that makes a machine.

![The app asks for a machine of the kind worker; it does not know where it will run. AWS has four places for it, by market, type and zone. spot c8g in us-east-1a answers busy zone: the next zone. us-east-1b answers busy type: the next type. spot c7g answers busy market: the next market. demand c7g in us-east-1a answers ok: the machine runs there.](_media/failover.svg)

## 1. The Order

```
for entry in kind.try:
    places = the entry's places, sold now, risky ones removed
    for market in entry.market:
        for type in entry.types:
            for place of this market and type, by zone name:
                try it
                ok            → the machine
                busy zone     → the next zone
                busy type     → the next type, in every market of the entry
                busy market   → the next market
                busy account  → the next entry; on spot, the next market
                an error      → thrown to the app
no place made one → null
```

- **Each place once:** no place is tried twice in one failover.
- **Zones by name:** every failover follows the same order.
- **A spot quota is its own:** a full spot quota is no room on spot, not in the account, so the entry's next market, like `demand`, is tried next.
- **Only what is sold:** a type a zone does not sell is skipped without a try.

| `Busy`    | No room                                  | For example, on aws                        |
| --------- | ---------------------------------------- | ------------------------------------------ |
| `ZONE`    | for this type in this zone               | `InsufficientInstanceCapacity`             |
| `TYPE`    | for this type anywhere in this entry     | no distro image for its arch in the region |
| `MARKET`  | in this market: price, or a market limit | `SpotMaxPriceTooLow`                       |
| `ACCOUNT` | in this account: a quota                 | `VcpuLimitExceeded`                        |

Each provider maps its cloud's errors to these in its data file; any other error is thrown, not failed over.

```ts
rig.on(Event.TRY, ({ kind, place, answer }) => {
    console.log(kind, place.provider, place.market, place.type, place.zone, answer);
});
```

## 2. Risk

On `spot`, a cloud may take a machine back. The core estimates how often, per place, as a percent a month: `takeback`. It needs nothing from the cloud but each type's shape.

- **Before it has seen a place,** its risk is a prior, from the type: `5` for 2 vCPU or fewer, `8` above, `25` with a GPU; more for larger types, less on arm. A `demand` place's is `0`.
- **As it runs machines there,** its own counts lead: tries, busy answers, machines created, lost, and the hours they ran, kept in `./.rig/rig/1/risk.json`.
- **A place often full** counts as riskier: its busy answers raise its estimate.

```ts
// places above 10% a month are not tried
const worker = aws.presets.compute({ name: "worker", risk: { max: "10%" } });

// each place, in failover order, with its risk
const places = await rig.place.list("worker");
```

The formula, with its constants, is in the spec, §15: every core computes it the same way.

## 3. Guard

When it opens, the core checks every kind for risk, and emits each finding once, as `GUARD`; with `guard: Guard.REFUSE`, it then refuses to open.

| `Finding`     | When                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| `SPOT_WARN`   | `spot` in any entry: a take-back may come with little warning, its data with it |
| `SPOT_LONG`   | `spot`, no `life`, and a spot place whose `takeback` is above `10`              |
| `SPOT_NARROW` | `spot`, and fewer than `3` spot places in all: one busy pool takes them all     |

A job on spot keeps its own work: save progress in its own steps, and resume from there.

## 4. Rounds

Every `every` (30 s by default), the core lists its machines on every provider, and compares them with its store:

| Seen                                         | Is         | The core                                                        |
| -------------------------------------------- | ---------- | --------------------------------------------------------------- |
| in the store, gone or ended, not by the core | **lost**   | counts it, ends what it left, emits `MACHINE_LOST`, recovers it |
| in the store, older than its kind's `life`   | **old**    | ends it, emits `MACHINE_ENDED`                                  |
| not in the store, of a kind in the config    | **found**  | takes it into the store; a job machine is ended                 |
| not in the store, of no kind in the config   | **orphan** | emits `MACHINE_ORPHAN`, never ends it                           |

The core finds its machines by their tags: `rig`, `rig-app`, `rig-kind`, `rig-name`. It never touches a machine of another app, or another generation.

## 5. Recover

A recover is a failover for the lost machine's kind, from its first entry.

![A machine runs on AWS, spot c8g in us-east-1a. Each round, every 30 s, the core lists its machines. The cloud takes it back; at the next round it is not in the list: lost. The core recovers it by failover: us-east-1a answers busy zone, us-east-1b answers ok, and a new machine runs there.](_media/recover.svg)

What comes of it:

| Result           | The core                                     |
| ---------------- | -------------------------------------------- |
| a machine        | emits `MACHINE_RECOVERED`, with the lost one |
| no room          | tries again the next round                   |
| `recovers` spent | stops, emits `MACHINE_FAILED`                |

`recovers` (default `3`) counts the replacements along a chain: a lost machine, its replacement, the replacement's replacement. With `recovers: 0`, a lost machine is not replaced. `rig.machine.lost()` lists the lost machines still waiting for theirs.
