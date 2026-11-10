/** How a machine is paid: `spot` may be taken back by the provider, `demand` stays. */
export type Market = "spot" | "demand";

/** Why a try found no room. */
export type Busy = "zone" | "type" | "market" | "account";

/** A machine's status, mapped from the provider's own. */
export type Status = "pending" | "running" | "stopping" | "stopped" | "ending" | "ended";

export type Tags = Record<string, string>;

/** One item of a kind's `try` list. */
export type Entry = {
    provider: string;
    market: Market[];
    types: string[];
    image?: string;
    extra?: Record<string, unknown>;
};

/** A named recipe for machines. */
export type Kind = {
    name: string;
    try: Entry[];
    image?: string;
    disk?: number;
    script?: string;
    risk?: { max: string };
    life?: string;
    recovers?: number;
    /** The app's own tags; no key starts with `rig`. */
    tags?: Tags;
};

/** Where a machine could be created. */
export type Place = {
    market: Market;
    type: string;
    zone: string;
    price?: string;
    rate?: string;
};

/** What to create, filled by the core. */
export type Spec = {
    name: string;
    image?: string;
    disk?: number;
    script?: string;
    tags: Tags;
    extra?: Record<string, unknown>;
};

/** What one try gave. */
export type Answer = { ok: { id: string } } | { busy: Busy; message?: string };

/** A machine as the provider sees it. */
export type ProviderMachine = {
    id: string;
    status: Status;
    market: Market;
    type: string;
    zone: string;
    tags: Tags;
    ip?: { public?: string; private?: string };
    created: number;
};

/** One port rule. */
export type Rule = {
    id?: string;
    port: number;
    to?: number;
    proto?: "tcp" | "udp";
    from: string;
};

export type Can = {
    spot?: boolean;
    stop?: boolean;
    disk?: boolean;
    port?: boolean;
};

/** A plugin for one cloud. */
export type Provider = {
    slot: "provider";
    name: string;
    rig: number;
    can?: Can;
    /** Optional: throws when the provider cannot work, checked at open. */
    check?(): Promise<void>;
    places(entry: Entry): Promise<Place[]>;
    create(place: Place, spec: Spec): Promise<Answer>;
    get(id: string): Promise<ProviderMachine | null>;
    list(tags: Tags): Promise<ProviderMachine[]>;
    end(id: string): Promise<void>;
    reboot(id: string): Promise<void>;
    start?(id: string): Promise<void>;
    stop?(id: string): Promise<void>;
    disk?: {
        grow(id: string, gb: number): Promise<void>;
        get(id: string): Promise<{ gb: number; ready: boolean }>;
    };
    port?: {
        open(id: string, rule: Rule): Promise<Rule>;
        close(id: string, rule: string): Promise<void>;
        list(id: string): Promise<Rule[]>;
    };
};

export type Config = {
    rig: number;
    app: string;
    providers: Provider[];
    kinds: Kind[];
    guard?: "warn" | "refuse";
    every?: string;
    poll?: string;
    store?: string;
};

/** A machine as the app sees it. */
export type Machine = ProviderMachine & {
    provider: string;
    kind: string;
    name: string;
};

/** The core's own count for one place. */
export type Seen = { created: number; lost: number; hours: number };

export type Risk = { rate?: string; source?: string; seen: Seen };

/** A place as `place.list` gives it. */
export type Listed = Place & { provider: string; risk: Risk };

export type Code = "spot-warn" | "spot-long";

export type Events = {
    try: { kind: string; place: Place & { provider: string }; answer: Answer | { error: unknown } };
    "machine:created": { machine: Machine };
    "machine:ended": { machine: Machine };
    "machine:lost": { machine: Machine };
    "machine:recovered": { lost: Machine; machine: Machine };
    "machine:failed": { machine: Machine; recovers: number };
    "machine:orphan": { machine: Machine };
    guard: { kind: string; code: Code };
};

/** What a lib adds to the config; not part of the spec. */
export type Options = {
    /** The clock, in unix ms; the kit sets its own. */
    clock?: () => number;
    /** Run rounds every `every`; `false` leaves them to `round()`. */
    rounds?: boolean;
    /** The wait between polls; the kit moves its clock instead. */
    sleep?: (ms: number) => Promise<void>;
};
