// The unified `bg_*` / `job_*` / `tm_*` registry: `task_status`, `task_wait` and `task_cancel`
// route by id prefix (or task name) to whichever provider owns the item.
import { randomBytes } from "node:crypto";
/** `bg_1a2b3c4d`: short enough to copy back, random enough to stay unique for a process. */
export function newItemId(kind) {
    return `${kind}_${randomBytes(4).toString("hex")}`;
}
/** Exact id, or a unique prefix of at least `kind_` + 4 characters; ambiguity is an error. */
export function resolvePrefix(ids, ref) {
    const all = [...ids];
    if (all.includes(ref))
        return ref;
    const underscore = ref.indexOf("_");
    if (underscore < 0 || ref.length - underscore - 1 < 4)
        return undefined;
    const matches = all.filter((id) => id.startsWith(ref));
    if (matches.length > 1)
        throw new Error(`ambiguous id ${ref}; matches ${matches.join(", ")}`);
    return matches[0];
}
export class DispatchRegistry {
    providers = [];
    register(provider) {
        if (!this.providers.includes(provider))
            this.providers.push(provider);
    }
    resolve(ref) {
        const trimmed = ref.trim();
        for (const provider of this.providers) {
            const id = provider.resolve(trimmed);
            if (id !== undefined)
                return { provider, id };
        }
        throw new Error(`unknown dispatch item ${JSON.stringify(ref)}; use task_status({}) to list bg_*, job_* (or task names) and tm_* items`);
    }
    list() {
        return this.providers.flatMap((provider) => provider.list());
    }
    hasFiniteWork() {
        return this.list().some((item) => item.active && item.finite);
    }
    /** Milliseconds until the last finite item's deadline, or undefined when none has one. */
    maxRemainingMs(now = Date.now()) {
        const deadlines = this.list().filter((item) => item.active && item.finite && item.deadlineAt !== undefined)
            .map((item) => item.deadlineAt - now);
        return deadlines.length === 0 ? undefined : Math.max(0, ...deadlines);
    }
    /** `In flight: 2 bg_*, 1 job_*` -- the one line a post-compaction wake starts with. */
    activeSummary() {
        const counts = new Map();
        for (const item of this.list()) {
            if (!item.active)
                continue;
            counts.set(item.kind, [...(counts.get(item.kind) ?? []), item.name ?? item.id]);
        }
        if (counts.size === 0)
            return undefined;
        const parts = [...counts].map(([kind, ids]) => `${ids.length} ${kind}_* (${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", ..." : ""})`);
        return `[dispatch] In flight after compaction: ${parts.join("; ")}. task_status({}) lists them.`;
    }
}
//# sourceMappingURL=registry.js.map