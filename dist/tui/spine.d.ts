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
    /** A tool still running: its branch lights up while the turn's spine pulses. */
    readonly spineRunning?: boolean;
}
export declare function spineMember(component: object): SpineMember | undefined;
/** One block's rows as GroupedMessages placed them. `member` undefined: not part of a turn. */
export interface SpineBlock {
    lines: string[];
    member: SpineMember | "spacer" | undefined;
}
/**
 * Paints the spine into `blocks`' lines in place. `running`: a turn is in progress, so the last turn
 * that has no footer yet is live. Narrower than 4 columns there is no room for it.
 */
export declare function paintSpine(theme: Theme, blocks: SpineBlock[], width: number, running: boolean, now?: number): void;
//# sourceMappingURL=spine.d.ts.map