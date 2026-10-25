import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
/** D85: effective context can omit failed attempts before recovery itself fails. Keep the last
 * completed request separately. Read only after prompt()/runPrintMode() has settled, not agent_end. */
export declare function trackRequestOutcome(): {
    extension: InlineExtension;
    error: (messages: AgentSession["messages"]) => string | undefined;
    /** True when that failed request was a context overflow, which a child reports as a partial run
     * rather than a failure (docs/development.md §12.4): the session file survives and can resume. */
    overflow: (messages: AgentSession["messages"]) => boolean;
};
//# sourceMappingURL=request-outcome.d.ts.map