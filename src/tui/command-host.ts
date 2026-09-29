// What built-in commands and key actions may touch in the app (docs/tui-design.md 4.6, 4.7).
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
  /** Append a block to the transcript (command output, info panels). */
  addBlock(component: Component): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  /** Editor text with large-paste markers (`[paste #1 +N lines]`) expanded to their full content;
   * use this, not `getEditorText`, for anything actually sent (submit, steer, external editor). */
  getExpandedEditorText(): string;
  /** Insert text at the editor's cursor, e.g. a pasted clipboard image's file path. */
  insertEditorText(text: string): void;
  /** Record text in the editor's up-arrow history without submitting it. */
  addToHistory(text: string): void;
  /** Run the submit pipeline (built-ins, `!`, `session.prompt`) as if Enter were pressed. */
  submit(text: string): Promise<void>;
  /** Pi's restoreQueuedMessagesToEditor/clearAllQueues (interactive-mode.js ~3729, ~3761): clears
   * both the session's own steering/follow-up queue and app.ts's compaction queue, puts their text
   * back in the editor (ahead of anything already typed), and returns how many messages that was.
   * Shared by Esc/Ctrl+C (app.interrupt/app.clear), Alt+Up (app.message.dequeue), and the extension
   * abort handler, so none of them can see only one of the two queues. */
  restoreQueuedMessagesToEditor(): number;
  /** True while an agent turn is running. */
  isWorking(): boolean;
  toggleToolsExpanded(): void;
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
