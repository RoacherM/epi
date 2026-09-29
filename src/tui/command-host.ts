// What built-in commands and key actions may touch in the app (docs/tui-design.md 4.6, 4.7).
import type { AgentSession, AgentSessionRuntime, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type NoticeTone = "info" | "warning" | "error";

export interface CommandHost {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly cwd: string;
  readonly runtime: AgentSessionRuntime;
  /** The current session; it changes after /new, /resume, /reload and forks. */
  session(): AgentSession;
  /** Show a component where the editor is; the returned function puts the editor back. */
  takeEditorSlot(component: Component): () => void;
  notice(text: string, tone?: NoticeTone): void;
  /** Append a block to the transcript (command output, info panels). */
  addBlock(component: Component): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  /** True while an agent turn is running. */
  isWorking(): boolean;
  toggleToolsExpanded(): void;
  exit(code?: number): Promise<void>;
}
