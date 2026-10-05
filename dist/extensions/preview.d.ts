import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PaneSource, PlayerHost, PlayerPane } from "./preview/player-pane.js";
/** The extension's own version, apart from Epi's (docs/architecture.md: built-in extensions are
 * versioned on their own; the change log is in docs/guide/preview.md, the tags are preview-v*). */
export declare const PREVIEW_VERSION = "0.3.0";
/** The pi.events channel other extensions ask for the video player on (docs/preview-design.md §5.2):
 * they emit `{}` and find `player` filled in when emit returns. */
export declare const PREVIEW_PLAYER_CHANNEL = "epi/preview/player/v1";
export interface PreviewPlayerApi {
    createPane(source: PaneSource, host: PlayerHost): Promise<PlayerPane>;
}
export declare function createPreviewInlineExtension(): InlineExtension;
//# sourceMappingURL=preview.d.ts.map