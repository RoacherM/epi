// What a subagent job looks like in the inspector (docs/subagents-design.md §11.5): its status, the
// task it was given, and its conversation so far, read from the job's own session file. Pure text:
// task.ts opens it and refreshes it while the job runs.
import { readFileSync } from "node:fs";

import type { Theme } from "@earendil-works/pi-coding-agent";

import type { InspectTarget } from "../tui/buffer/inspector.js";
import { singleLine } from "../task-result.js";
import type { TaskJobSnapshot } from "../task-runtime.js";

/** Characters of one tool result the view keeps; the whole result is in the session file. */
const RESULT_PREVIEW_CHARS = 600;
/** Characters of one tool call's arguments on its line. */
const ARGS_PREVIEW_CHARS = 160;

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface Entry {
  type?: string;
  summary?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean };
}

function parts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Part[]) : [];
}

function textOf(content: unknown): string {
  return parts(content).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function argsLine(args: unknown): string {
  if (args === undefined || args === null) return "";
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "url", "query", "task"]) {
    if (typeof record[key] === "string") return singleLine(record[key], ARGS_PREVIEW_CHARS);
  }
  return singleLine(JSON.stringify(args), ARGS_PREVIEW_CHARS);
}

function messageLines(theme: Theme, entry: Entry): string[] {
  const message = entry.message!;
  switch (message.role) {
    case "user":
      return [theme.fg("accent", "❯ user"), ...textOf(message.content).split("\n"), ""];
    case "assistant": {
      const out: string[] = [];
      for (const part of parts(message.content)) {
        if (part.type === "text" && part.text?.trim()) out.push(...part.text.trim().split("\n"));
        else if (part.type === "thinking" && part.thinking?.trim()) out.push(theme.fg("dim", `∴ ${singleLine(part.thinking, ARGS_PREVIEW_CHARS)}`));
        else if (part.type === "toolCall") out.push(`${theme.fg("muted", "◆")} ${theme.fg("toolOutput", part.name ?? "tool")} ${theme.fg("muted", argsLine(part.arguments))}`);
      }
      return out.length === 0 ? [] : [theme.fg("accent", "◇ assistant"), ...out, ""];
    }
    case "toolResult": {
      const text = textOf(message.content).trimEnd();
      const cut = text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text;
      const tone = message.isError === true ? "error" : "dim";
      const lines = cut === "" ? ["(no output)"] : cut.split("\n");
      return [...lines.map((line) => theme.fg(tone, `  ${line}`)), ""];
    }
    default:
      return [];
  }
}

/** The conversation in a job's session file, or a note saying why there is none yet. Pi writes the
 * file only once the first reply exists, and appends to it after each message. */
function conversationLines(theme: Theme, sessionPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return [theme.fg("muted", code === "ENOENT" ? "(no conversation yet: the session file appears after the first reply)" : `(cannot read ${sessionPath}: ${String(error)})`)];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // The last line can be half written while the child appends.
    }
    if (entry.type === "compaction") out.push(theme.fg("warning", `── compacted: ${singleLine(entry.summary ?? "", ARGS_PREVIEW_CHARS)}`), "");
    else if (entry.type === "message" && entry.message !== undefined) out.push(...messageLines(theme, entry));
  }
  return out;
}

function headerLines(theme: Theme, job: TaskJobSnapshot): string[] {
  const facts = [`turn ${job.turns ?? 0}`, `${job.steps ?? 0} steps`];
  if (job.compactions !== undefined && job.compactions > 0) facts.push(`${job.compactions} compactions`);
  const lines = [`${theme.fg("accent", job.agent ?? "task")} ${theme.bold(job.status)} ${theme.fg("muted", facts.join(" · "))}`];
  if (job.currentActivity !== undefined) lines.push(theme.fg("muted", `now: ${job.currentActivity}`));
  lines.push(theme.fg("dim", `session: ${job.sessionPath}`), "");
  return lines;
}

function outcomeLines(theme: Theme, job: TaskJobSnapshot): string[] {
  if (job.status === "failed" && job.error !== undefined) return [theme.fg("error", `✗ ${job.error}`)];
  if (job.status === "cancelled") return [theme.fg("warning", "cancelled")];
  return [];
}

/** The inspector target for `job`, built fresh: call it again to refresh a running job's view. */
export function taskViewTarget(theme: Theme, job: TaskJobSnapshot): InspectTarget {
  const lines = [...headerLines(theme, job), ...conversationLines(theme, job.sessionPath), ...outcomeLines(theme, job)];
  const text = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
  return { title: `task ${job.id.slice(0, 8)}`, subtitle: job.status, lines, text, wrap: true };
}

/** One row per job in the jobs list: `◐ 2be97ffa running reader · turn 3 · bash: npm test`. */
export function jobRow(theme: Theme, job: TaskJobSnapshot): string {
  const glyph = job.status === "completed" ? theme.fg("success", "✓")
    : job.status === "failed" ? theme.fg("error", "✗")
    : job.status === "running" ? theme.fg("accent", "◐")
    : theme.fg("muted", "·");
  const where = job.status === "running" ? `turn ${job.turns ?? 0}${job.currentActivity === undefined ? "" : ` · ${job.currentActivity}`}` : `${job.turns ?? 0} turns`;
  return `${glyph} ${theme.fg("muted", job.id.slice(0, 8))} ${job.status} ${theme.fg("accent", job.agent ?? "task")} · ${where} · ${singleLine(job.task ?? "", 60)}`;
}
