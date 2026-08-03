import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MmpRuntimeIdentity } from "./runtime-identity.js";
export type MmpStartupTheme = Pick<Theme, "bold" | "fg">;
export declare function renderMmpStartupPage(identity: MmpRuntimeIdentity, theme: MmpStartupTheme, terminalWidth: number): string[];
//# sourceMappingURL=startup-page.d.ts.map