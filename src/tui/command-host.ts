// What built-in commands and key actions may touch in the app (docs/tui-design.md 4.6, 4.7).
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionRuntime, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { ProjectIdentity } from "./project-guard.js";

export type NoticeTone = "info" | "warning" | "error";

export interface CommandHost {
  readonly tui: TUI;
  readonly theme: Theme;
  /** The current session's cwd; like session(), it changes after /new, /resume, /reload and forks. */
  readonly cwd: string;
  /** MMP's Pi state directory (~/.mmp/pi): where /trust's ProjectTrustStore lives. */
  readonly agentDir: string;
  readonly runtime: AgentSessionRuntime;
  /** The project this process assembled its manifest from; used to refuse a cross-project /resume. */
  readonly projectIdentity: ProjectIdentity;
  /** The current session; it changes after /new, /resume, /reload and forks. */
  session(): AgentSession;
  /** Show a component where the editor is; the returned function puts the editor back. `focus`
   * targets keyboard input at a child instead of `component` itself, for a component (like Pi's
   * UserMessageSelectorComponent) whose own handleInput lives only on a sub-component. */
  takeEditorSlot(component: Component, focus?: Component): () => void;
  notice(text: string, tone?: NoticeTone): void;
  /** A one-second message in the corner (TuiAltScreen.flash), for key feedback that shouldn't stay
   * in the transcript. */
  flash(text: string): void;
  /** Append a block to the transcript (command output, info panels). */
  addBlock(component: Component): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  /** Sent text back into the editor with its images, each under the `[Image #N]` label it was
   * sent under (ChipEditor.restoreDraftImages); labels left without an image show as unattached. */
  restoreEditorDraft(text: string, images: readonly ImageContent[]): void;
  /** Editor text with paste chips (`[Pasted: N lines]`) expanded to their full content; image
   * chips (`[Image #N]`) keep their label in the text (D11); use this, not `getEditorText`, for anything actually sent
   * (submit, steer, external editor). Pair with `getEditorImages()` to also carry attachments. */
  getExpandedEditorText(): string;
  /** Image attachments currently represented by `[Image #N]` chips in the editor (docs/tui-design.md
   * 4.3); pass alongside `getExpandedEditorText()`'s result to `session.prompt`/`steer`/`followUp`. */
  getEditorImages(): ImageContent[];
  /** Insert text at the editor's cursor without folding it into a chip, e.g. an extension's
   * programmatic snippet insertion. Ctrl+V's text case uses `pasteText` instead. */
  insertEditorText(text: string): void;
  /** Ctrl+V with text on the clipboard: same fold-or-not decision as a terminal bracketed paste
   * (docs/tui-design.md 4.3), so a large clipboard paste chips exactly like a large terminal one. */
  pasteText(text: string): void;
  /** Ctrl+V with an image on the clipboard, or an image file path dropped/pasted in: adds an
   * `[Image #N]` chip at the cursor (docs/tui-design.md 4.3). */
  insertImage(bytes: Uint8Array, mimeType: string): void;
  /** Record text in the editor's up-arrow history without submitting it. */
  addToHistory(text: string): void;
  /** Run the submit pipeline (built-ins, `!`, `session.prompt`) as if Enter were pressed. */
  submit(text: string, images?: ImageContent[]): Promise<void>;
  /** Alt+Enter while a turn runs: clear the draft and send text and images into the running turn
   * (`session.prompt` with `streamingBehavior: "steer"`); its `[Image #N]` labels count as used
   * (D11). On failure it says why and puts the text and its images back. */
  steer(text: string, images: ImageContent[]): Promise<void>;
  /** Pi's restoreQueuedMessagesToEditor/clearAllQueues (interactive-mode.js ~3729, ~3761): clears
   * both the session's own steering/follow-up queue and app.ts's compaction queue, puts their text
   * back in the editor (ahead of anything already typed), and returns how many messages that was.
   * Shared by Esc/Ctrl+C (app.interrupt/app.clear), Alt+Up (app.message.dequeue), and the extension
   * abort handler, so none of them can see only one of the two queues. */
  restoreQueuedMessagesToEditor(): number;
  /** Call before `session.abort()` when the user stops the running prompt (Esc, Ctrl+C, leaving it
   * for /tree): its footer reads "Stopped after" (dogfood D17). */
  markRunStopped(): void;
  /** True while an agent turn is running. */
  isWorking(): boolean;
  /** Drop the turn status row. Only for Esc when the row shows but the session is idle (dogfood
   * D15): every normal path clears it from session events. */
  clearTurnStatus(): void;
  toggleToolsExpanded(): void;
  /** Ctrl+T (docs/tui-design.md 4.2/4.6, `app.thinking.toggle`): expands/collapses every finished
   * thinking block, independent of Ctrl+O's tool/user-message toggle. */
  toggleThinkingExpanded(): void;
  exit(code?: number): Promise<void>;
  /** `session.reload()` rebuilds resources and the extension runtime in place; it does not go
   * through AgentSessionRuntime, so it skips setBeforeSessionInvalidate/setRebindSession. This
   * redoes the host-owned parts of docs/tui-design.md 6.3 (widgets, autocomplete, keybindings). */
  reloadSession(): Promise<void>;
  /** Clear the transcript and replay `session.messages` from scratch. `session.navigateTree()`
   * (unlike /new, /resume, /reload) moves the leaf without going through AgentSessionRuntime, so
   * it never triggers `setRebindSession`; /tree calls this itself afterward (docs/tui-design.md §15). */
  resetTranscript(): void;
}
