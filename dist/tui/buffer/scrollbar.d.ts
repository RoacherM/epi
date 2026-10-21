import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
export interface ScrollbarStyle {
    /** Color of the thumb `┃`. */
    thumb: ThemeColor;
    /** Color of the track `│`. */
    track: ThemeColor;
    /** The column when everything fits: blank (default), or a plain `│` in this color (a frame edge). */
    fits?: ThemeColor;
}
/** `height` rows of the scrollbar for `total` rows, `visible` of them shown from `offset`. */
export declare function scrollbar(theme: Theme, total: number, visible: number, offset: number, height: number, style?: ScrollbarStyle): string[];
/** The scroll offset for a click or drag on scrollbar row `row` of `height`. */
export declare function scrollFromBar(row: number, height: number, total: number, visible: number): number;
//# sourceMappingURL=scrollbar.d.ts.map