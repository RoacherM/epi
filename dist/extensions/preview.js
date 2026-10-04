import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { ChangeLedger } from "./preview/ledger.js";
/** The extension's own version, apart from MMP's (docs/architecture.md: built-in extensions are
 * versioned on their own; the change log is in docs/guide/preview.md, the tags are preview-v*). */
export const PREVIEW_VERSION = "0.2.0";
/**
 * `/preview [path]`: the page for seeing what the agent changed, and any other file, without
 * leaving MMP (docs/preview-design.md): the agent's changes with their diffs, and a three-pane file
 * browser with a viewer for text, Markdown, binaries, images and video. A bundled interface feature
 * for the interactive TUI, not a Manifest capability: it registers one command and event handlers,
 * and nothing the model sees. The page (pi-tui components, ffmpeg handling) loads on first use.
 */
/** `@path` for the editor; quoted the way Pi's own file completion writes a path with spaces. */
function fileReference(path) {
    return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}
export function createPreviewInlineExtension() {
    return {
        name: "mmp:preview",
        factory: (pi) => {
            // One ledger per session: the factory runs again for /new, /resume, /fork and /reload.
            const ledger = new ChangeLedger();
            pi.on("tool_call", (event, ctx) => {
                ledger.onToolCall(event.toolName, event.input, ctx.cwd);
            });
            pi.on("agent_start", () => ledger.onAgentStart());
            pi.on("agent_end", () => ledger.onAgentEnd());
            // The overlay that is open, so a session that ends under it stops its video and sound.
            let open;
            pi.on("session_shutdown", () => {
                open?.dispose();
                open = undefined;
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
                    let start;
                    if (args.trim() === "") {
                        start = changedFiles(ledger, "session").length > 0 ? { side: "changes" } : { side: "files", dir: ctx.cwd };
                    }
                    else {
                        const target = resolve(ctx.cwd, args.trim().replace(/^~(?=$|\/)/, homedir()));
                        let isDirectory;
                        try {
                            isDirectory = statSync(target).isDirectory();
                        }
                        catch {
                            ctx.ui.notify(`/preview: ${target} does not exist`, "error");
                            return;
                        }
                        start = isDirectory ? { side: "files", dir: target } : { side: "files", dir: dirname(target), file: basename(target) };
                    }
                    const result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
                        const page = new PreviewPage(tui, theme, ledger, ctx.cwd, done, start);
                        open = page;
                        return page;
                    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
                    open = undefined;
                    if (!result)
                        return;
                    // A line break would cut the reference in two in the message: the agent could not find the
                    // file. Such a name is left out and named instead (JSON-quoted, so it is safe to draw).
                    const paths = result.paths.map((path) => FileBrowser.display(ctx.cwd, path));
                    const unusable = paths.filter((path) => /[\r\n]/.test(path));
                    if (unusable.length > 0) {
                        ctx.ui.notify(`${unusable.map((path) => JSON.stringify(path)).join(", ")}: a line break in the name, so it cannot be inserted as a reference`, "warning");
                    }
                    const refs = paths.filter((path) => !unusable.includes(path)).map(fileReference).join(" ");
                    if (refs === "")
                        return;
                    const text = ctx.ui.getEditorText();
                    ctx.ui.setEditorText(text && !text.endsWith(" ") ? `${text} ${refs} ` : `${text}${refs} `);
                },
            });
        },
    };
}
//# sourceMappingURL=preview.js.map