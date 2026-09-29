import type { CommandHost } from "./command-host.js";
/** Pi's handleCompactCommand ignores the throw: compact() already emitted a `compaction_end`
 * event with the failure reason, which transcript.ts turns into a notice. Pi does not refuse
 * this command while a turn is running either; `session.compact` aborts it first. */
export declare function runCompact(host: CommandHost, customInstructions: string): Promise<void>;
/** `/resume`: session selector for the current cwd (Tab switches to "all", like Pi's). Picking a
 * session hands off to `runtime.switchSession`, whose rebind callback (app.ts's `bind`) replays
 * the transcript. Sessions only ever come from the session manager's own directory, which MMP
 * points at `~/.mmp/pi/sessions` (never Pi's `~/.pi/agent`); see services.ts and paths.ts. */
export declare function runResume(host: CommandHost): Promise<void>;
/** `/thinking [level]`: set directly when the level is valid for the current model, otherwise
 * open the selector (also reachable with no argument). */
export declare function runThinking(host: CommandHost, levelArg: string): Promise<void>;
/** `/copy` and the `app.message.copy` key: copy the last assistant reply to the clipboard.
 * Pi also prefers a live mouse-selection when the key triggers it from `TuiAltScreen`; MMP has no
 * such selection state wired into CommandHost yet, so this always copies the last assistant text. */
export declare function runCopy(host: CommandHost): Promise<void>;
/** `/reload`: like Pi, refuse while a turn or compaction is running, then `session.reload()` and
 * rebuild the host state it doesn't cover (docs/tui-design.md 6.3) via `host.reloadSession`. */
export declare function runReload(host: CommandHost): Promise<void>;
//# sourceMappingURL=session-commands.d.ts.map