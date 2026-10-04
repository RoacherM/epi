import type { InlineExtension } from "@earendil-works/pi-coding-agent";
/** The extension's own version, apart from MMP's (docs/architecture.md: built-in extensions are
 * versioned on their own; the change log is in docs/guide/preview.md, the tags are preview-v*). */
export declare const PREVIEW_VERSION = "0.1.0";
/**
 * `/preview [path]`: the dedicated view for looking at files without leaving MMP for an editor:
 * a three-pane browser and a full viewer for text, Markdown, binaries, images and video. A bundled
 * interface feature for the interactive TUI, not a Manifest capability: it registers one command
 * and nothing the model sees. The view (pi-tui components, ffmpeg handling) loads on first use.
 */
export declare function createPreviewInlineExtension(): InlineExtension;
//# sourceMappingURL=preview.d.ts.map