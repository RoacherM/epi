import { type ProjectTrustUpdate } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
export interface ShouldAskProjectTrustOptions {
    /** stdin/stdout are TTYs and the Pi args select interactive mode (see src/interactive.ts). */
    interactive: boolean;
    dryRun: boolean;
    noProject: boolean;
    /** From --approve/--no-approve, or a trust choice already made earlier in this run. */
    trustOverride: boolean | undefined;
    /** The nearest ancestor with .epi/epi.json, or undefined when none was found. */
    projectRoot: string | undefined;
    /** ProjectTrustStore.get(projectRoot): null means no one has decided yet. */
    savedDecision: boolean | null;
}
/** Pure so the decision can be unit-tested without a terminal, a project, or a trust store. */
export declare function shouldAskProjectTrust(options: ShouldAskProjectTrustOptions): boolean;
export interface ProjectTrustChoice {
    label: string;
    trusted: boolean;
    updates: ProjectTrustUpdate[];
}
/**
 * Mirrors Pi's own trust prompt options (core/trust-manager.js getProjectTrustOptions), which Epi
 * cannot import directly: index.js only re-exports ProjectTrustStore and
 * hasTrustRequiringProjectResources from that module. Saved decisions still go through the same
 * exported ProjectTrustStore, so both stores stay compatible.
 */
export declare function projectTrustOptions(root: string): ProjectTrustChoice[];
export interface AskProjectTrustOptions {
    root: string;
    /** Injected by tests (see test/fixtures/tui-harness.mjs); defaults to the real terminal. */
    terminal?: Terminal;
}
/**
 * Draws a small select list on the main screen (not the alternate screen: nothing else is on
 * screen yet) and resolves once the user picks an option or cancels. Esc/Ctrl+C cancels: do not
 * trust this run, nothing saved. The terminal is fully restored before this returns, so piMain or
 * TUI v2 can start its own session right after.
 */
export declare function askProjectTrust(options: AskProjectTrustOptions): Promise<ProjectTrustChoice>;
/** Persists the chosen updates (if any) to the same store Epi's `/trust` and classic Pi's `/trust` use. */
export declare function saveProjectTrustChoice(agentDir: string, choice: ProjectTrustChoice): void;
//# sourceMappingURL=trust-prompt.d.ts.map