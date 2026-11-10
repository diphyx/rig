export type Reason = "generation" | "plugin" | "config" | "guard" | "unsupported" | "unknown" | "closed" | "timeout";

/** The core declining a config, a plugin or a call. Code reads only `reason`. */
export class Refusal extends Error {
    readonly reason: Reason;

    constructor(reason: Reason, message: string) {
        super(message);

        this.name = "Refusal";
        this.reason = reason;
    }
}
