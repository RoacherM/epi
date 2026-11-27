import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DispatchHostAdapter, DispatchRole } from "./types.js";
export declare const OutboxParameters: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"notify">, Type.TLiteral<"ask">]>;
    summary: Type.TString;
    details: Type.TOptional<Type.TString>;
    dedupKey: Type.TOptional<Type.TString>;
}>;
export declare function createOutboxTool(host: DispatchHostAdapter, sessionId: () => string | undefined, notifyUi: (text: string) => void): ToolDefinition<typeof OutboxParameters>;
/** `tool_call` gate + `/approve <id> [allow|deny]`; grants are single-use and expire after 30m. */
export declare function installApprovalGuard(pi: ExtensionAPI, host: DispatchHostAdapter, role: DispatchRole): void;
//# sourceMappingURL=outbox-guard.d.ts.map