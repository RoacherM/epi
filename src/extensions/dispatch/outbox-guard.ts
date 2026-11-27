// Silent-first outbox and the in-memory `/approve` guard (docs/dispatch-design.md §3.6). An
// unattended run that has nothing to say ends silently; `outbox` is how it notifies or asks
// (hard de-duplicated by `dedupKey`). When the host classifies a tool call as `defer`, a worker is
// refused outright and the root parks the exact call until a trusted `/approve <id>` grants it once.
import { randomBytes } from "node:crypto";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { DispatchHostAdapter, DispatchRole, OutboxItem } from "./types.js";

const DEDUP_RING = 100;
const GRANT_TTL_MS = 30 * 60_000;

export const OutboxParameters = Type.Object({
  action: Type.Union([Type.Literal("notify"), Type.Literal("ask")]),
  summary: Type.String({ description: "One-line message for the user" }),
  details: Type.Optional(Type.String()),
  dedupKey: Type.Optional(Type.String({ description: "Same key = same message; repeats are dropped" })),
});

export function createOutboxTool(
  host: DispatchHostAdapter,
  sessionId: () => string | undefined,
  notifyUi: (text: string) => void,
): ToolDefinition<typeof OutboxParameters> {
  const recent: string[] = [];
  return {
    name: "outbox",
    label: "Outbox",
    description: "Tell the user something (notify) or ask them a question (ask) from an unattended run. Stay silent when there is nothing worth reporting.",
    parameters: OutboxParameters,
    async execute(_toolCallId, params: Static<typeof OutboxParameters>) {
      if (params.dedupKey !== undefined && recent.includes(params.dedupKey)) {
        return { content: [{ type: "text", text: `Already sent (dedupKey ${params.dedupKey}); nothing new delivered.` }], details: { duplicate: true } };
      }
      if (params.dedupKey !== undefined) {
        recent.push(params.dedupKey);
        if (recent.length > DEDUP_RING) recent.shift();
      }
      const item: OutboxItem = {
        action: params.action, summary: params.summary, sessionId: sessionId(),
        ...(params.details === undefined ? {} : { details: params.details }),
        ...(params.dedupKey === undefined ? {} : { dedupKey: params.dedupKey }),
      };
      if (host.onOutbox !== undefined) await host.onOutbox(item);
      else notifyUi(`[${params.action}] ${params.summary}`);
      const tail = params.action === "ask" ? " End this turn; the answer arrives as a new message." : "";
      return { content: [{ type: "text", text: `Delivered (${params.action}).${tail}` }], details: { duplicate: false } };
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface PendingCall { key: string; toolName: string; input: unknown }

/** `tool_call` gate + `/approve <id> [allow|deny]`; grants are single-use and expire after 30m. */
export function installApprovalGuard(pi: ExtensionAPI, host: DispatchHostAdapter, role: DispatchRole): void {
  const classify = host.classifyToolCall;
  if (classify === undefined) return;
  const pending = new Map<string, PendingCall>();
  const grants = new Map<string, number>();
  pi.on("tool_call", (event) => {
    const verdict = classify({ toolName: event.toolName, input: event.input, role });
    if (verdict === "allow") return undefined;
    if (verdict === "block" || role !== "root") {
      return { block: true, reason: verdict === "block" ? `${event.toolName} is blocked by policy` : `${event.toolName} needs approval; return to the parent with a partial result explaining what you need` };
    }
    const key = `${event.toolName}\0${canonicalJson(event.input)}`;
    const grant = grants.get(key);
    if (grant !== undefined && grant > Date.now()) {
      grants.delete(key);
      return undefined;
    }
    const id = `ap_${randomBytes(3).toString("hex")}`;
    pending.set(id, { key, toolName: event.toolName, input: event.input });
    return { block: true, terminate: true, reason: `${event.toolName} is waiting for approval (${id}). Stop here; the user approves with /approve ${id} allow.` };
  });
  if (role !== "root") return;
  pi.registerCommand("approve", {
    description: "Approve or deny a deferred tool call: /approve <id> [allow|deny]",
    handler: async (args, ctx) => {
      const [id = "", verdict = "allow"] = args.trim().split(/\s+/);
      const call = pending.get(id);
      if (call === undefined || (verdict !== "allow" && verdict !== "deny")) {
        ctx.ui.notify(`usage: /approve <id> [allow|deny]; pending: ${[...pending.keys()].join(", ") || "none"}`, "warning");
        return;
      }
      pending.delete(id);
      if (verdict === "allow") grants.set(call.key, Date.now() + GRANT_TTL_MS);
      const text = verdict === "allow"
        ? `Approved ${id}: re-issue ${call.toolName} with exactly these arguments: ${JSON.stringify(call.input)}`
        : `Denied ${id}: do not run ${call.toolName} with ${JSON.stringify(call.input)}.`;
      pi.sendMessage({ customType: "dispatch:approval", content: text, display: true, details: { id, verdict } }, { triggerTurn: true });
    },
  });
}
