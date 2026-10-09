// D85: real Pi recovery, with deterministic model responses and optional compaction interception.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  let scenario;
  let attempts = 0;
  let summarizing = false;
  pi.on("before_agent_start", event => {
    scenario = event.prompt.split(" ")[0];
    attempts = 0;
    summarizing = false;
  });
  pi.on("input", event => event.text === "handled" ? { action: "handled" } : undefined);
  pi.on("message_end", event => {
    if (scenario === "replace" && event.message.role === "assistant") {
      return { message: { ...event.message, stopReason: "stop", errorMessage: undefined, content: [fauxText("REPLACED")] } };
    }
  });
  pi.registerCommand("fresh", { description: "Replace session", handler: async (_args, ctx) => { await ctx.newSession(); } });
  pi.registerCommand("refresh", { description: "Reload session", handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerTool({
    name: "finish", label: "Finish", description: "Finish without another model response", parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {}, terminate: true }),
  });
  pi.on("session_before_compact", event => {
    if (scenario === "cancel") return { cancel: true };
    if (scenario === "summary-fail" || scenario === "threshold-fail") {
      summarizing = true;
      return;
    }
    return { compaction: {
      summary: "Recovery summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } };
  });
  const reply = () => {
    if (summarizing) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 summary failed" });
    if (scenario === "tools") return fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason: "toolUse" });
    if (scenario === "threshold-fail") return fauxAssistantMessage(fauxText("SUCCESS"));
    if (scenario === "ok" || (scenario === "recover" && attempts++ > 0)) return fauxAssistantMessage(fauxText("SUCCESS"));
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 context_length_exceeded" });
  };
  registerFaux(pi, { models: ["echo"], responses: Array.from({ length: 12 }, () => reply) });
}
