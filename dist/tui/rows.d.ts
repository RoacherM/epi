import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
/** A child's rows in its parent's render. `skipped` leading rows of the child's own render were
 * dropped from the parent's (W2's trimmed blank row): a click is handed on that many rows lower. */
export interface ChildRows {
    component: Component;
    height: number;
    skipped?: number;
}
/** Hands `event` to the child whose rows contain it, in that child's own row coordinates. */
export declare function dispatchToRows(rows: readonly ChildRows[], event: TuiMouseEvent): TuiMouseEventResult | undefined;
//# sourceMappingURL=rows.d.ts.map