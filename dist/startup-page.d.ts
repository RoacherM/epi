import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MmpRuntimeIdentity } from "./runtime-identity.js";
export type MmpStartupTheme = Pick<Theme, "bold" | "fg" | "italic">;
export interface MmpStartupPageOptions {
    modelName?: string;
    modelProvider?: string;
    modelId?: string;
}
export declare function renderMmpStartupPage(identity: MmpRuntimeIdentity, theme: MmpStartupTheme, terminalWidth: number, options?: MmpStartupPageOptions): string[];
//# sourceMappingURL=startup-page.d.ts.map