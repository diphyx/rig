# rig

Create machines on any cloud, with failover.

**Status: draft.** The spec is being written; no package is published yet.

## 1. What It Does

Creating one machine is easy. Getting one when the cloud has no room is not. Rig tries the next place until a machine is created:

```
   app: "a machine of kind worker"
              │
              ▼
            core ──► try ──► busy ──► next place ──► try ──► ... ──► machine
                              │
                              ├── another zone
                              ├── another type
                              ├── spot → demand
                              └── another provider
```

On `spot`, the provider may take a machine back. Rig counts how often that happens per place, replaces lost machines, and warns about risky kinds when it opens.

## 2. A Taste

The planned TypeScript API.

```ts
import { createRig } from "@diphyx/rig";
import { aws } from "@diphyx/rig-aws";

const cloud = aws({ region: "us-east-1" });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [cloud],
    kinds: [
        cloud.small({ name: "dev" }),
        cloud.compute({ name: "worker", cpu: 8 }), // spot first, then demand
    ],
});

await rig.open();

const machine = await rig.machine.create("worker"); // null if no room anywhere
await rig.machine.wait(machine.id, "running"); // live status and ip from the provider
rig.on("machine:lost", ({ machine }) => { ... });
```

**Presets** (`small`, `general`, `compute`, `memory`, `gpu`) make a kind from a name, with no type names to look up. Every provider has the same ones.

For full control, write the kind yourself. The order is the failover order:

```ts
{
    name: "worker",
    try: [
        { provider: "aws", market: ["spot"],   types: ["c8g.2xlarge", "c7g.2xlarge"] },
        { provider: "gcp", market: ["spot"],   types: ["c4a-standard-8"] },
        { provider: "aws", market: ["demand"], types: ["c8g.2xlarge"] },
    ],
    risk: { max: "10%" },
}
```

## 3. How It Is Built

```
   ┌──────────────── core ────────────────┐
   │  failover · risk · recover · guard   │
   └──────────────────┬───────────────────┘
                      │  the provider contract
        ┌─────────────┼─────────────┬──────────────┐
        ▼             ▼             ▼              ▼
       aws           gcp          azure          yours
```

- **Spec first.** [`spec/SPEC.md`](spec/SPEC.md) is the contract, and [`spec/kit/`](spec/kit) proves it. Any core and any provider that follow it work together, in any language.
- **One official lib:** TypeScript, framework-free. A library, not a CLI.
- **Providers are plugins.** The core has no cloud in it. Official `aws`, `gcp`, `azure`, each optional, or your own.
- **Generations.** Each major is a fixed contract, `rig: 1`. Minors and patches only add. A new generation never reads or touches the machines of another.

| Package             | Is                 | Needed   |
| ------------------- | ------------------ | -------- |
| `@diphyx/rig`       | the core           | always   |
| `@diphyx/rig-aws`   | the aws provider   | optional |
| `@diphyx/rig-gcp`   | the gcp provider   | optional |
| `@diphyx/rig-azure` | the azure provider | optional |

At least one provider: official, or your own.

## 4. Develop

| Path             | Is                             |
| ---------------- | ------------------------------ |
| `spec/SPEC.md`   | the contract                   |
| `spec/kit/`      | the conformance suite, as data |
| `packages/core`  | `@diphyx/rig`, passes the kit  |
| `packages/aws`   | `@diphyx/rig-aws`, planned     |
| `packages/gcp`   | `@diphyx/rig-gcp`, planned     |
| `packages/azure` | `@diphyx/rig-azure`, planned   |

```bash
pnpm install
pnpm run build   # every package
pnpm run check   # types, lint, format, tests, the kit
```

## License

MIT
