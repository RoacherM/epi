import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EpiRuntimeIdentity } from "./runtime-identity.js";
import { type MotionTheme } from "./tui/motion.js";
export type EpiStartupTheme = Pick<Theme, "bold" | "fg" | "italic">;
export interface EpiStartupPageOptions {
    modelName?: string;
    modelProvider?: string;
    modelId?: string;
}
/** How strongly the welcome page animates `elapsedMs` after it was first drawn; 0 once settled. */
export declare function welcomeMotionStrength(elapsedMs: number): number;
/** The static welcome page: the same layout as every animated frame, with nothing lit. */
export declare function renderEpiStartupPage(identity: EpiRuntimeIdentity, theme: EpiStartupTheme, terminalWidth: number, options?: EpiStartupPageOptions): string[];
/** One animated frame at `t` seconds: the logo shimmers and the section rules pulse, scaled by
 * `strength` (see welcomeMotionStrength). */
export declare function renderAnimatedEpiStartupPage(identity: EpiRuntimeIdentity, theme: EpiStartupTheme & MotionTheme, terminalWidth: number, options: EpiStartupPageOptions, t: number, strength?: number): string[];
//# sourceMappingURL=startup-page.d.ts.map