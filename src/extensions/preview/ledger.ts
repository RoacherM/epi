// The change ledger (docs/preview-design.md §2): what each file was before the agent changed it.
// Fed by the extension's tool_call and agent_start/agent_end handlers; read by the changes view.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { MAX_TEXT_BYTES } from "./files.js";

/** A file before the agent changed it: its text, absent (the agent created it), or not kept. */
export type Snapshot =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "not-kept"; reason: string };

/** "session": since the session started; "turn": in the latest turn that ran. */
export type Scope = "session" | "turn";

export interface Change {
  path: string;
  before: Snapshot;
}

interface Entry {
  sessionBefore: Snapshot;
  /** The turn this file was last changed in, and what it was before that turn's first change. */
  turn: number;
  turnBefore: Snapshot;
}

/** Tools that write files, and where their path argument is (Pi's built-in edit and write). */
const WRITING_TOOLS = new Set(["edit", "write"]);

function snapshot(path: string): Snapshot {
  try {
    const size = statSync(path).size;
    if (size > MAX_TEXT_BYTES) return { kind: "not-kept", reason: "larger than 4 MB" };
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "not-kept", reason: "could not be read before the change" };
  }
}

export class ChangeLedger {
  private turn = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  /** The agent is running a turn. */
  running = false;

  /** A tool is about to run: keep what a file it writes looks like now. */
  onToolCall(toolName: string, input: unknown, cwd: string): void {
    if (!WRITING_TOOLS.has(toolName)) return;
    const path = (input as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || path === "") return;
    const absolute = resolve(cwd, path);
    const entry = this.entries.get(absolute);
    if (entry === undefined) {
      const before = snapshot(absolute);
      this.entries.set(absolute, { sessionBefore: before, turn: this.turn, turnBefore: before });
    } else if (entry.turn !== this.turn) {
      entry.turn = this.turn;
      entry.turnBefore = snapshot(absolute);
    }
    this.notify();
  }

  onAgentStart(): void {
    this.turn += 1;
    this.running = true;
    this.notify();
  }

  onAgentEnd(): void {
    this.running = false;
    this.notify();
  }

  /** Changed files in the scope, sorted by path. */
  changes(scope: Scope): Change[] {
    const changes: Change[] = [];
    for (const [path, entry] of this.entries) {
      if (scope === "session") changes.push({ path, before: entry.sessionBefore });
      else if (entry.turn === this.turn) changes.push({ path, before: entry.turnBefore });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Called on every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
