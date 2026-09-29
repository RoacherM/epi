import type { CommandHost } from "./command-host.js";
/** `/fork`: pick a previous user message, then `runtime.fork(entryId)`. Like Pi, the original
 * text is put back in the editor so the user can edit it before resending down the new branch. */
export declare function runFork(host: CommandHost): Promise<void>;
/** `/clone`: fork at the current leaf, staying on the same point in the conversation (Pi's
 * handleCloneCommand). Nothing to clone from yet ("Nothing to clone yet" in Pi) if there's no leaf. */
export declare function runClone(host: CommandHost): Promise<void>;
/** `/tree`: navigate the session tree. `session.navigateTree` stays on the same AgentSession
 * instance (unlike /new, /resume, /fork), so `setRebindSession` never fires for it; the transcript
 * is replayed here with `host.resetTranscript()`, mirroring Pi's own
 * `chatContainer.clear(); renderInitialMessages()` in showTreeSelector. */
export declare function runTree(host: CommandHost, initialSelectedId?: string): Promise<void>;
//# sourceMappingURL=session-tree-commands.d.ts.map