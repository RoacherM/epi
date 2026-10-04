import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** The extension's own version, apart from MMP's (docs/architecture.md: built-in extensions are
 * versioned on their own; the change log is in docs/guide/preview.md, the tags are preview-v*). */
export const PREVIEW_VERSION = "0.1.0";

/**
 * `/preview [path]`: the dedicated view for looking at files without leaving MMP for an editor:
 * a three-pane browser and a full viewer for text, Markdown, binaries, images and video. A bundled
 * interface feature for the interactive TUI, not a Manifest capability: it registers one command
 * and nothing the model sees. The view (pi-tui components, ffmpeg handling) loads on first use.
 */
export function createPreviewInlineExtension(): InlineExtension {
  return {
    name: "mmp:preview",
    factory: (pi) => {
      pi.registerCommand("preview", {
        description: "Browse and view files (text, Markdown, images, video); i inserts @path into the editor",
        handler: async (args, ctx) => {
          if (ctx.mode !== "tui") {
            ctx.ui.notify("/preview needs the interactive TUI", "error");
            return;
          }
          const target = resolve(ctx.cwd, args.trim().replace(/^~(?=$|\/)/, homedir()) || ".");
          let isDirectory: boolean;
          try {
            isDirectory = statSync(target).isDirectory();
          } catch {
            ctx.ui.notify(`/preview: ${target} does not exist`, "error");
            return;
          }
          const { FileBrowser } = await import("./preview/view.js");
          const result = await ctx.ui.custom<{ paths: string[] } | undefined>(
            (tui, theme, _keybindings, done) =>
              isDirectory ? new FileBrowser(tui, theme, target, done) : new FileBrowser(tui, theme, dirname(target), done, basename(target)),
            { overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center" } },
          );
          if (!result) return;
          const refs = result.paths.map((path) => `@${FileBrowser.display(ctx.cwd, path)}`).join(" ");
          const text = ctx.ui.getEditorText();
          ctx.ui.setEditorText(text && !text.endsWith(" ") ? `${text} ${refs} ` : `${text}${refs} `);
        },
      });
    },
  };
}
