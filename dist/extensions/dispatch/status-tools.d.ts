import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BgProcessRuntime } from "./bg-bash.js";
import type { NotificationLedger, PollGuard } from "./notify-ledger.js";
import type { DispatchRegistry } from "./registry.js";
export interface StatusToolDeps {
    registry: DispatchRegistry;
    ledger: NotificationLedger;
    pollGuard: PollGuard;
    bg: BgProcessRuntime;
    /** Worker slices see only their own items; the description says so. */
    scope: "all" | "own";
}
export declare function createStatusTools(deps: StatusToolDeps): ToolDefinition[];
//# sourceMappingURL=status-tools.d.ts.map