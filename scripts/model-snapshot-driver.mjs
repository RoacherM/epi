// Faux model for scripts/model-snapshot.mjs: on the first (and only) prompt, captures exactly what
// a real provider would receive -- the leading system message's text and tool declarations -- and
// writes it to MMP_MODEL_SNAPSHOT_OUT, then returns a fixed reply so the run completes normally.
//
// Context.systemPrompt/tools are shorthand that pi-ai's normalizeContext() folds into a leading
// SystemMessage before any provider sees it (pi-ai's types.d.ts: "Replaying every system message in
// order yields the current prompt and tools"); this is the same shape faux.js itself reads to
// render a system message to text, so it's public request shape, not a private one.
import { writeFileSync } from "node:fs";

import { fauxAssistantMessage, fauxText, getSystemMessageText } from "@earendil-works/pi-ai";
import { registerFaux } from "../test/fixtures/faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["snapshot"],
    responses: [
      (context) => {
        const leadingSystem = context.messages.find((message) => message.role === "system");
        if (leadingSystem === undefined) {
          throw new Error("model-snapshot-driver: no leading system message in the request context");
        }
        const systemPrompt = getSystemMessageText(leadingSystem);
        const tools = (leadingSystem.toolsAdded ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
        writeFileSync(process.env.MMP_MODEL_SNAPSHOT_OUT, JSON.stringify({ systemPrompt, tools }));
        return fauxAssistantMessage(fauxText("SNAPSHOT_OK"));
      },
    ],
  });
}
