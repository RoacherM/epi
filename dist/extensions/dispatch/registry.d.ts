import type { DispatchItemKind, DispatchItemProvider, DispatchItemSummary } from "./types.js";
/** `bg_1a2b3c4d`: short enough to copy back, random enough to stay unique for a process. */
export declare function newItemId(kind: DispatchItemKind): string;
/** Exact id, or a unique prefix of at least `kind_` + 4 characters; ambiguity is an error. */
export declare function resolvePrefix(ids: Iterable<string>, ref: string): string | undefined;
export declare class DispatchRegistry {
    private readonly providers;
    register(provider: DispatchItemProvider): void;
    resolve(ref: string): {
        provider: DispatchItemProvider;
        id: string;
    };
    list(): DispatchItemSummary[];
    hasFiniteWork(): boolean;
    /** Milliseconds until the last finite item's deadline, or undefined when none has one. */
    maxRemainingMs(now?: number): number | undefined;
    /** `In flight: 2 bg_*, 1 job_*` -- the one line a post-compaction wake starts with. */
    activeSummary(): string | undefined;
}
//# sourceMappingURL=registry.d.ts.map