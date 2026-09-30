// /compact, /resume, /thinking, /copy (and the app.message.copy key), /reload
// (docs/tui-design.md 4.6); registered in builtins.ts and keys.ts.
// The flows follow Pi's interactive mode, built from the components Pi exports.
import {
  type AgentSession,
  ExtensionSelectorComponent,
  SessionManager,
  SessionSelectorComponent,
  ThinkingSelectorComponent,
} from "@earendil-works/pi-coding-agent";

import { writeClipboardText } from "./clipboard.js";
import type { CommandHost } from "./command-host.js";
import { errorText } from "./errors.js";
import { crossProjectRefusal } from "./project-guard.js";

type ThinkingLevel = AgentSession["thinkingLevel"];

export interface MissingSessionCwdIssue {
  sessionFile?: string;
  sessionCwd: string;
  fallbackCwd: string;
}

/**
 * Duck-types Pi's `MissingSessionCwdError` (core/session-cwd.js): thrown by
 * `AgentSessionRuntime.switchSession` when the session's stored cwd no longer exists, but not part
 * of the SDK's export surface (only "." is exported, so the class itself can't be imported). The
 * class sets `this.name = "MissingSessionCwdError"` and carries the same `issue` shape, which is
 * stable to check for instead.
 */
export function missingSessionCwdIssue(error: unknown): MissingSessionCwdIssue | undefined {
  if (!(error instanceof Error) || error.name !== "MissingSessionCwdError") return undefined;
  const issue = (error as { issue?: unknown }).issue;
  return issue as MissingSessionCwdIssue | undefined;
}

/** Mirrors Pi's formatMissingSessionCwdPrompt (core/session-cwd.js), also not exported. */
function formatMissingSessionCwdPrompt(issue: MissingSessionCwdIssue): string {
  return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

/**
 * Mirrors Pi's promptForMissingSessionCwd/showExtensionConfirm (interactive-mode.js ~2073-2079):
 * a Yes/No dialog offering to continue the switch in the current cwd instead. MMP has no dedicated
 * extension-confirm dialog wired to app.ts, so this reuses the same ExtensionSelectorComponent the
 * SDK's own extension `ui.confirm` uses (ext-host.ts), taking the editor slot directly.
 */
export async function confirmMissingSessionCwd(host: CommandHost, issue: MissingSessionCwdIssue): Promise<string | undefined> {
  const confirmed = await new Promise<boolean>((resolve) => {
    let restore: () => void = () => {};
    const selector = new ExtensionSelectorComponent(
      `Session cwd not found\n${formatMissingSessionCwdPrompt(issue)}`,
      ["Yes", "No"],
      (choice) => {
        restore();
        resolve(choice === "Yes");
      },
      () => {
        restore();
        resolve(false);
      },
    );
    restore = host.takeEditorSlot(selector);
  });
  return confirmed ? issue.fallbackCwd : undefined;
}

/** Pi's handleCompactCommand ignores the throw: compact() already emitted a `compaction_end`
 * event with the failure reason, which transcript.ts turns into a notice. Pi does not refuse
 * this command while a turn is running either; `session.compact` aborts it first, so a running
 * prompt (including its post-run overflow compaction) was stopped by the user (dogfood D37). */
export async function runCompact(host: CommandHost, customInstructions: string): Promise<void> {
  if (host.session().isStreaming) host.markRunStopped();
  const trimmed = customInstructions.trim();
  try {
    await host.session().compact(trimmed === "" ? undefined : trimmed);
  } catch {
    // Ignore: already reported via the compaction_end event.
  }
}

/** What the session selector actually did: `"resumed"` picked a session (whether or not it went on
 * to actually switch -- resumeSession reports its own refusals via a notice); `"cancelled"` is Esc,
 * matching Pi's own selectSession returning no path; `"exited"` is Ctrl+D, which already quit the
 * app itself (host.exit(0), below) -- distinguished from `"cancelled"` so a caller like app.ts's
 * `--resume`-at-startup handling (bug 8) doesn't print its own message on top of an unrelated quit. */
export type ResumeOutcome = "resumed" | "cancelled" | "exited";

/** `/resume`: session selector for the current cwd (Tab switches to "all", like Pi's). Picking a
 * session hands off to `runtime.switchSession`, whose rebind callback (app.ts's `bind`) replays
 * the transcript. Sessions only ever come from the session manager's own directory, which MMP
 * points at `~/.mmp/pi/sessions` (never Pi's `~/.pi/agent`); see services.ts and paths.ts. */
export async function runResume(host: CommandHost): Promise<ResumeOutcome> {
  const sessionManager = host.session().sessionManager;
  return new Promise<ResumeOutcome>((resolve) => {
    let restore: () => void = () => {};
    const selector = new SessionSelectorComponent(
      (onProgress, signal) => SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir(), onProgress, signal),
      (onProgress, signal) => sessionManager.usesDefaultSessionDir()
        ? SessionManager.listAll(onProgress, signal)
        : SessionManager.listAll(sessionManager.getSessionDir(), onProgress, signal),
      (sessionPath) => {
        restore();
        void resumeSession(host, sessionPath).then(() => resolve("resumed"));
      },
      () => {
        restore();
        resolve("cancelled");
      },
      () => {
        restore();
        resolve("exited");
        void host.exit(0);
      },
      () => host.tui.requestRender(),
      undefined,
      sessionManager.getSessionFile(),
    );
    restore = host.takeEditorSlot(selector);
  });
}

async function resumeSession(host: CommandHost, sessionPath: string): Promise<void> {
  // Check before the runtime tears down the current session (docs/tui-design.md §15): a refused
  // switch must leave the running session exactly as it was. crossProjectRefusal itself can throw
  // (a malformed session file); the switch below cannot -- app.ts's runtime.switchSession wrapper
  // handles MissingSessionCwdError and any other failure itself (bug 7: fatal on teardown failure).
  let refusal: string | undefined;
  try {
    refusal = crossProjectRefusal(sessionPath, host.projectIdentity);
  } catch (error) {
    host.notice(`Could not resume session: ${errorText(error)}`, "error");
    return;
  }
  if (refusal !== undefined) {
    host.notice(refusal, "warning");
    return;
  }
  const result = await host.runtime.switchSession(sessionPath);
  if (!result.cancelled) host.notice("Resumed session.");
}

/** `/thinking [level]`: set directly when the level is valid for the current model, otherwise
 * open the selector (also reachable with no argument). */
export async function runThinking(host: CommandHost, levelArg: string): Promise<void> {
  const session = host.session();
  const trimmed = levelArg.trim().toLowerCase();
  if (trimmed !== "") {
    const available = session.getAvailableThinkingLevels();
    const level = available.find((candidate) => candidate.toLowerCase() === trimmed);
    if (level === undefined) {
      host.notice(`Unknown thinking level "${levelArg.trim()}". Available levels: ${available.join(", ")}.`, "error");
      return;
    }
    selectThinkingLevel(host, level, false);
    return;
  }
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selectLevel = (level: ThinkingLevel, persist: boolean) => {
      restore();
      selectThinkingLevel(host, level, persist);
      resolve();
    };
    const selector = new ThinkingSelectorComponent(
      session.thinkingLevel,
      session.getAvailableThinkingLevels(),
      (level) => selectLevel(level, false),
      () => {
        restore();
        resolve();
      },
      (level) => selectLevel(level, true),
      session.settingsManager.getDefaultThinkingLevel(),
    );
    restore = host.takeEditorSlot(selector);
  });
}

function selectThinkingLevel(host: CommandHost, level: ThinkingLevel, persist: boolean): void {
  try {
    host.session().setThinkingLevel(level, { persist });
    host.notice(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
  } catch (error) {
    host.notice(errorText(error), "error");
  }
}

/** `/copy` and the `app.message.copy` key: copy the last assistant reply to the clipboard.
 * Pi also prefers a live mouse-selection when the key triggers it from `TuiAltScreen`; MMP has no
 * such selection state wired into CommandHost yet, so this always copies the last assistant text. */
export async function runCopy(host: CommandHost): Promise<void> {
  const text = host.session().getLastAssistantText();
  if (text === undefined) {
    host.notice("No agent messages to copy yet.", "warning");
    return;
  }
  try {
    await writeClipboardText(text);
    host.notice("Copied last agent message to clipboard.");
  } catch (error) {
    host.notice(errorText(error), "error");
  }
}

/** `/reload`: like Pi, refuse while a turn or compaction is running, then `session.reload()` and
 * rebuild the host state it doesn't cover (docs/tui-design.md 6.3) via `host.reloadSession`. */
export async function runReload(host: CommandHost): Promise<void> {
  const session = host.session();
  if (session.isStreaming) {
    host.notice("Wait for the current response to finish before reloading.", "warning");
    return;
  }
  if (session.isCompacting) {
    host.notice("Wait for compaction to finish before reloading.", "warning");
    return;
  }
  try {
    await host.reloadSession();
    host.notice("Reloaded keybindings, extensions, skills, prompts, themes, and context files.");
  } catch (error) {
    host.notice(`Reload failed: ${errorText(error)}`, "error");
  }
}
