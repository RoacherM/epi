import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EpiRuntimeIdentity } from "./runtime-identity.js";
export type EpiStartupTheme = Pick<Theme, "bold" | "fg" | "italic">;
export interface EpiStartupPageOptions {
    modelName?: string;
    modelProvider?: string;
    modelId?: string;
}
export declare function renderEpiStartupPage(identity: EpiRuntimeIdentity, theme: EpiStartupTheme, terminalWidth: number, options?: EpiStartupPageOptions): string[];
//# sourceMappingURL=startup-page.d.ts.map