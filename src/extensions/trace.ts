// `/trace`: the session's execution trace in a full-screen page (docs/trace-design.md). This is the
// registration half: it observes SDK events into a recorder and wires the page to the current
// session. The page, projection and formats are separate modules. Nothing here changes what the
// model sees; the command is a bundled interface feature, so it loads only in the interactive TUI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import { TraceRecorder } from "./trace/record.js";

/** The extension's own version, apart from Epi's (docs/architecture.md §3.6). */
export const TRACE_VERSION = "0.1.0";

/** The current git branch, read from HEAD without invoking git. Mirrors the app's own reader. */
function readGitBranch(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
    } catch {
      if (dirname(dir) === dir) return undefined;
    }
  }
}

export function createTraceInlineExtension(): InlineExtension {
  return {
    name: "epi:trace",
    factory: (pi) => {
      // One recorder per session: the factory runs again for /new, /resume, /fork and /reload, so
      // observations never leak across sessions (docs/trace-design.md §9).
      const recorder = new TraceRecorder();
      pi.on("agent_start", () => recorder.agentStart());
      pi.on("agent_end", () => recorder.agentEnd());
      pi.on("tool_execution_start", (event) => recorder.toolStart(event.toolCallId, event.toolName, event.parentToolCallId));
      pi.on("tool_execution_end", (event) => recorder.toolEnd(event.toolCallId));
      // Branch-changing events repaint; the page re-projects only when the leaf moved.
      pi.on("message_end", () => recorder.touch());
      pi.on("turn_end", () => recorder.touch());
      pi.on("agent_settled", () => recorder.touch());
      pi.on("session_compact", () => recorder.touch());
      pi.on("session_tree", () => recorder.touch());
      pi.on("model_select", () => recorder.touch());
      pi.on("thinking_level_select", () => recorder.touch());

      let open: { dispose(): void } | undefined;
      let ended = false;
      pi.on("session_shutdown", () => {
        ended = true;
        open?.dispose();
        open = undefined;
      });

      pi.registerCommand("trace", {
        description: "See the session's execution trace: timeline, one line per step, and the call's payload, result, schema and timing",
        handler: async (_args, ctx) => {
          if (ctx.mode !== "tui") {
            ctx.ui.notify("/trace needs the interactive TUI", "error");
            return;
          }
          if (ended) return;
          const { TracePage } = await import("./trace/page.js");
          const session = ctx.sessionManager;
          const branch = () => readGitBranch(ctx.cwd);
          await ctx.ui.custom<void>(
            (tui, theme, _keybindings, done) => {
              const page = new TracePage({ tui, theme, session, recorder, cwd: ctx.cwd, branch, done });
              open = page;
              return page;
            },
            { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
          );
          open = undefined;
        },
      });
    },
  };
}
