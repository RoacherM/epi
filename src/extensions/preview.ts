import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import { ChangeLedger } from "./preview/ledger.js";
import type { PageStart } from "./preview/page.js";
import type { PaneSource, PlayerHost, PlayerPane } from "./preview/player-pane.js";

/** The extension's own version, apart from Epi's (docs/architecture.md: built-in extensions are
 * versioned on their own; the change log is in docs/guide/preview.md, the tags are preview-v*). */
export const PREVIEW_VERSION = "0.3.0";

/** The pi.events channel other extensions ask for the video player on (docs/preview-design.md §5.2):
 * they emit `{}` and find `player` filled in when emit returns. */
export const PREVIEW_PLAYER_CHANNEL = "epi/preview/player/v1";

export interface PreviewPlayerApi {
  createPane(source: PaneSource, host: PlayerHost): Promise<PlayerPane>;
}

/** What createPane rejects: an empty video, or a line break in a header, which would split ffmpeg's
 * `-headers` value into other headers. */
function checkPaneSource(source: PaneSource): void {
  if (typeof source?.video !== "string" || source.video === "") throw new Error("createPane: video is empty");
  for (const [name, value] of Object.entries(source.headers ?? {})) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(String(value))) {
      throw new Error(`createPane: header ${JSON.stringify(name)} has a line break in its name or value`);
    }
  }
}

/**
 * `/preview [path]`: the page for seeing what the agent changed, and any other file, without
 * leaving Epi (docs/preview-design.md): the agent's changes with their diffs, and a three-pane file
 * browser with a viewer for text, Markdown, binaries, images and video. A bundled interface feature
 * for the interactive TUI, not a Manifest capability: it registers one command and event handlers,
 * and nothing the model sees. The page (pi-tui components, ffmpeg handling) loads on first use.
 */
/** `@path` for the editor; quoted the way Pi's own file completion writes a path with spaces. */
function fileReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export function createPreviewInlineExtension(): InlineExtension {
  return {
    name: "epi:preview",
    factory: (pi) => {
      // One ledger per session: the factory runs again for /new, /resume, /fork and /reload.
      const ledger = new ChangeLedger();
      pi.on("tool_call", (event, ctx) => {
        ledger.onToolCall(event.toolName, event.input, ctx.cwd);
      });
      pi.on("agent_start", () => ledger.onAgentStart());
      pi.on("agent_end", () => ledger.onAgentEnd());
      // The overlay that is open, so a session that ends under it stops its video and sound.
      let open: { dispose(): void } | undefined;
      // Panes handed to other extensions and not disposed yet: /new, /resume, /fork and /reload do not
      // end the process, so stopMediaProcesses would not stop a forgotten ffplay.
      const panes = new Set<PlayerPane>();
      // After this session ends nobody would dispose a new pane: createPane rejects, like Pi with a
      // stale pi/ctx, and the caller asks again to reach the new preview.
      let ended = false;
      const checkSession = (): void => {
        if (ended) throw new Error(`createPane: this player belongs to a session that has ended; ask on ${PREVIEW_PLAYER_CHANNEL} again`);
      };
      pi.on("session_shutdown", () => {
        ended = true;
        open?.dispose();
        open = undefined;
        for (const pane of [...panes]) pane.dispose();
      });
      const player: PreviewPlayerApi = {
        async createPane(source, host) {
          checkSession();
          const { PlayerPane } = await import("./preview/player-pane.js");
          // The session can end while the import is pending.
          checkSession();
          checkPaneSource(source);
          const pane: PlayerPane = new PlayerPane(source, host, () => panes.delete(pane));
          panes.add(pane);
          return pane;
        },
      };
      // Pi runs a handler synchronously only up to its first await, and an error thrown in it goes to
      // console.error over the TUI: so no await, nothing that throws, and a request that is not an
      // object is left alone. Reflect.set does not throw on a frozen request; the caller sees no player.
      pi.events.on(PREVIEW_PLAYER_CHANNEL, (request) => {
        if (typeof request === "object" && request !== null) Reflect.set(request, "player", player);
      });
      pi.registerCommand("preview", {
        description: "See what the agent changed (diffs) and browse files (text, Markdown, images, video); i inserts @path",
        handler: async (args, ctx) => {
          if (ctx.mode !== "tui") {
            ctx.ui.notify("/preview needs the interactive TUI", "error");
            return;
          }
          const [{ PreviewPage }, { FileBrowser }, { changedFiles }] = await Promise.all([
            import("./preview/page.js"), import("./preview/view.js"), import("./preview/changes.js"),
          ]);
          // No argument: the agent's changes when there are any. A path: that folder or file.
          let start: PageStart;
          if (args.trim() === "") {
            start = changedFiles(ledger, "session").length > 0 ? { side: "changes" } : { side: "files", dir: ctx.cwd };
          } else {
            const target = resolve(ctx.cwd, args.trim().replace(/^~(?=$|\/)/, homedir()));
            let isDirectory: boolean;
            try {
              isDirectory = statSync(target).isDirectory();
            } catch {
              ctx.ui.notify(`/preview: ${target} does not exist`, "error");
              return;
            }
            start = isDirectory ? { side: "files", dir: target } : { side: "files", dir: dirname(target), file: basename(target) };
          }
          const result = await ctx.ui.custom<{ paths: string[] } | undefined>(
            (tui, theme, _keybindings, done) => {
              const page = new PreviewPage(tui, theme, ledger, ctx.cwd, done, start);
              open = page;
              return page;
            },
            { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
          );
          open = undefined;
          if (!result) return;
          // A line break would cut the reference in two in the message: the agent could not find the
          // file. Such a name is left out and named instead (JSON-quoted, so it is safe to draw).
          const paths = result.paths.map((path) => FileBrowser.display(ctx.cwd, path));
          const unusable = paths.filter((path) => /[\r\n]/.test(path));
          if (unusable.length > 0) {
            ctx.ui.notify(
              `${unusable.map((path) => JSON.stringify(path)).join(", ")}: a line break in the name, so it cannot be inserted as a reference`,
              "warning",
            );
          }
          const refs = paths.filter((path) => !unusable.includes(path)).map(fileReference).join(" ");
          if (refs === "") return;
          const text = ctx.ui.getEditorText();
          ctx.ui.setEditorText(text && !text.endsWith(" ") ? `${text} ${refs} ` : `${text}${refs} `);
        },
      });
    },
  };
}
