import type { Theme } from "@earendil-works/pi-coding-agent";
export type MermaidResult = 
/** `rows`: the art, styled, no wider than the width asked for. `note`: what was given up on, if anything. */
{
    kind: "art";
    rows: string[];
    note: string | undefined;
}
/** Nothing to draw at this width: `note` says why. */
 | {
    kind: "source";
    note: string;
};
/** The diagram drawn into at most `width` columns, or why it isn't. Pure in `source` and `width`,
 * apart from the theme's colors. */
export declare function renderMermaid(theme: Theme, source: string, width: number): MermaidResult;
//# sourceMappingURL=mermaid.d.ts.map