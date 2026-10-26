import type { Theme } from "@earendil-works/pi-coding-agent";
import { type FlashState } from "./tools/flash.js";
/** `trunk`: every row on the trunk (reply text, thinking). `tool`: a branch into its first row.
 * `bash`: like `tool`, but a `!cmd` alone (no turn around it) gets no spine. `footer`: closes the turn. */
export type SpineRole = "trunk" | "tool" | "bash" | "footer";
/** What a transcript block tells the spine about itself, declared on the component. */
export interface SpineMember {
    readonly spineRole: SpineRole;
    /** The flash running on `row` of the block's last render, if any. */
    spineFlash?(row: number): FlashState | undefined;
    /** The row of `lines` (the block's rows as placed) being written right now -- a streaming reply's
     * last row, a running tool's last output row or its call row -- or undefined when nothing is. */
    spineWriteRow?(lines: readonly string[]): number | undefined;
}
/** The last row of `lines` with text, or undefined: where a block being written writes. */
export declare function lastTextRow(lines: readonly string[]): number | undefined;
export declare function spineMember(component: object): SpineMember | undefined;
/** One block's rows as GroupedMessages placed them. `member` undefined: not part of a turn. */
export interface SpineBlock {
    lines: string[];
    member: SpineMember | "spacer" | undefined;
}
export declare const TIP_ROWS = 8;
/**
 * A block whose rows change with the clock alone (a running tool's duration bar), not only when
 * something happens. While its clock row (the first row with text: the call row) is outside the
 * transcript's last TIP_ROWS rows, it draws at the time it last showed inside them (clock.ts), or
 * every frame would change a row that may have scrolled off -- the full redraw the spine's tip exists
 * to avoid. GroupedMessages sets `clockLive` before each render; an event (new arguments, output,
 * the result) still changes the rows wherever they are.
 */
export interface ClockGated {
    clockLive: boolean;
    /** The row that moves with the clock, when not the first row with text (a thinking run after the
     * reply's text). */
    readonly clockRow?: number | undefined;
}
export declare function isClockGated(component: object): component is ClockGated;
/**
 * Paints the spine into `blocks`' lines in place. `running`: a turn is in progress, so the last turn
 * is live if it has no footer yet and nothing outside a turn (the new prompt's user message) came
 * after it. Narrower than 4 columns there is no room for it.
 */
export declare function paintSpine(theme: Theme, blocks: SpineBlock[], width: number, running: boolean, now?: number): void;
//# sourceMappingURL=spine.d.ts.map