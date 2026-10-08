import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PreparedEpiRun } from "./host.js";
/** `isStdoutClosed`: closed-stdout.ts's guard, which host.ts installs for print/json only. */
export declare function runNonInteractive(prepared: PreparedEpiRun, extensionFactories: InlineExtension[], isStdoutClosed?: () => boolean): Promise<void>;
//# sourceMappingURL=noninteractive.d.ts.map