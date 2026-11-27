export declare const REPEAT_NOTE = "[epi: This call and its result are byte-identical to the previous one. Repeating it cannot produce new information: change the approach, or stop and tell the user what blocks you.]";
export declare function rawResultKey(content: ReadonlyArray<{
    type?: unknown;
    text?: unknown;
    data?: unknown;
    mimeType?: unknown;
}> | undefined): string;
/**
 * Threshold-free fixed-point detector: triggers only when the current tool exchange
 * (`(toolName, canonicalInput)` + `(isError, rawResult)`) is byte-identical to the
 * immediately preceding exchange. Resets on explicit user input, session start, and compaction.
 */
export declare class FixedPointGuard {
    private last;
    observe(toolName: string, input: unknown, isError: boolean, output: string): boolean;
    reset(): void;
}
//# sourceMappingURL=repeat-guard.d.ts.map