/* Every fixed set of values in the spec, as an enum; each value is the spec's own string. */

/** §3: how a machine is paid: `SPOT` may be taken back by the provider, `DEMAND` stays. */
export enum Market {
    SPOT = "spot",
    DEMAND = "demand",
}

/** §3: a machine's status, mapped from the provider's own. */
export enum Status {
    PENDING = "pending",
    RUNNING = "running",
    STOPPING = "stopping",
    STOPPED = "stopped",
    ENDING = "ending",
    ENDED = "ended",
}

/** §3, §11: where a try found no room. */
export enum Busy {
    ZONE = "zone",
    TYPE = "type",
    MARKET = "market",
    ACCOUNT = "account",
}

/** §10: a type's CPU architecture. */
export enum Arch {
    ARM = "arm",
    X86 = "x86",
}

/** §6.1: the Linux distribution a machine boots. */
export enum Distro {
    UBUNTU = "ubuntu",
    DEBIAN = "debian",
}

/** §10, §20: where a rule lets traffic in from, besides a CIDR of its own: anywhere on IPv4, on IPv6, or on both. */
export enum From {
    ANY = "any",
    ANY4 = "0.0.0.0/0",
    ANY6 = "::/0",
}

/** §10: a port rule's protocol. */
export enum Proto {
    TCP = "tcp",
    UDP = "udp",
}

/** §8: the slot a plugin fills. */
export enum Slot {
    PROVIDER = "provider",
    HUB = "hub",
}

/** §5, §17: what a guard finding does. */
export enum Guard {
    WARN = "warn",
    REFUSE = "refuse",
}

/** §17: a guard finding. */
export enum Finding {
    SPOT_WARN = "spot-warn",
    SPOT_LONG = "spot-long",
    SPOT_NARROW = "spot-narrow",
}

/** §18: the events the core emits. */
export enum Event {
    TRY = "try",
    MACHINE_CREATED = "machine:created",
    MACHINE_ENDED = "machine:ended",
    MACHINE_LOST = "machine:lost",
    MACHINE_RECOVERED = "machine:recovered",
    MACHINE_FAILED = "machine:failed",
    MACHINE_ORPHAN = "machine:orphan",
    GUARD = "guard",
}

/** §19: why the core refused. */
export enum Reason {
    GENERATION = "generation",
    PLUGIN = "plugin",
    CONFIG = "config",
    GUARD = "guard",
    UNSUPPORTED = "unsupported",
    UNKNOWN = "unknown",
    CLOSED = "closed",
    TIMEOUT = "timeout",
}

/** §16: the core's own state: made, open, or closed. */
export enum State {
    NEW = "new",
    OPEN = "open",
    CLOSED = "closed",
}

/** §7: the presets every provider offers. */
export enum PresetName {
    SMALL = "small",
    GENERAL = "general",
    COMPUTE = "compute",
    MEMORY = "memory",
    GPU = "gpu",
}

/** §7.2: a preset's CPU architecture; `ANY` is arm's types, then x86's. */
export enum PresetArch {
    ARM = "arm",
    X86 = "x86",
    ANY = "any",
}
