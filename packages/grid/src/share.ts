import path from "node:path";

import type { GridJob } from "./job.js";

/* A path in the job's space, `.` for the space itself. */
export function spacePath(value: string | undefined): string {
    return value ? path.posix.normalize(value) : ".";
}

function isUnder(inner: string, outer: string): boolean {
    return outer === "." || inner === outer || inner.startsWith(`${outer}/`);
}

/* What a share push needs (spec §10): a `to` that is not the space, and no other push or pull at it or under it, nor
   a pull that takes it in. A job that breaks it is refused before it is placed. */
export function shareProblem(job: GridJob): string | null {
    const pushes = job.push ?? [];

    for (const [index, share] of pushes.entries()) {
        if (!share.isShared) {
            continue;
        }

        const to = spacePath(share.to);

        if (to === ".") {
            return `push ${index + 1}: a share needs a \`to\`, not the space`;
        }

        const pushedInto = pushes.findIndex((other, at) => {
            return at !== index && isUnder(spacePath(other.to), to);
        });

        if (pushedInto !== -1) {
            return `push ${pushedInto + 1}: ${spacePath(pushes[pushedInto]!.to)} is in push ${index + 1}, a share`;
        }

        const pulled = (job.pull ?? []).find((pull) => {
            return isUnder(spacePath(pull.path), to) || isUnder(to, spacePath(pull.path));
        });

        if (pulled) {
            return `pull ${pulled.path}: it takes in push ${index + 1}, a share`;
        }
    }

    return null;
}
