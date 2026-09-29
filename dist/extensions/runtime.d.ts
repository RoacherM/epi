import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedAssembly } from "../assembly.js";
import { type MmpRuntimeIdentity } from "../runtime-identity.js";
export interface UpdateCheckOptions {
    mmpHome: string;
    currentVersion: string;
    disabled: boolean;
}
export declare function createMmpRuntimeExtension(initialIdentity: MmpRuntimeIdentity, initialAssembly: ResolvedAssembly, resolveAssembly?: () => ResolvedAssembly, updateCheck?: UpdateCheckOptions): InlineExtension;
//# sourceMappingURL=runtime.d.ts.map