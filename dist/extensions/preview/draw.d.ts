import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ImageDimensions } from "@earendil-works/pi-tui";
export declare function pad(text: string, width: number): string;
export declare function imageBody(base64: string, mimeType: string, theme: Theme, width: number, height: number, filename?: string, dimensions?: ImageDimensions, imageId?: number, center?: boolean): {
    lines: string[];
    imageId?: number;
};
/** Rows of a vertical scrollbar; blank when everything fits. */
export declare function scrollbar(theme: Theme, total: number, visible: number, offset: number, height: number): string[];
export declare function scrollFromBar(row: number, height: number, total: number, visible: number): number;
export declare function centered(text: string, width: number, height: number): string[];
//# sourceMappingURL=draw.d.ts.map