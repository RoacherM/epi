// A provider that streams like a real one: zero usage in every partial (so the app's token count
// is a chars/4 estimate mid-stream) and the true usage only on the final message. The faux core
// can't do this -- it computes usage up front and every partial carries it. Used to pin the
// status line's message_end calibration: the folded count must come from the final usage (13),
// not the last streamed estimate (2), and both the running row and the bottom border show ⇣13.
import { createAssistantMessageEventStream, fauxToolCall } from "@earendil-works/pi-ai";

const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const usage = (output) => ({ ...zeroUsage, input: 100, output, totalTokens: 100 + output });

function streamScripted(model, content, stopReason, outputTokens) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const base = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: zeroUsage, stopReason: "pending", timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...base } });
    content.forEach((block, index) => {
      if (block.type === "text") {
        base.content = [...base.content, { type: "text", text: "" }];
        stream.push({ type: "text_start", contentIndex: index, partial: { ...base } });
        base.content[index].text = block.text;
        stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: { ...base } });
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...base } });
      } else {
        base.content = [...base.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
        stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...base } });
        base.content[index].arguments = block.arguments;
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...base } });
      }
    });
    const message = { ...base, stopReason, usage: usage(outputTokens) };
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

export default function (pi) {
  const scripts = [
    { content: [{ type: "text", text: "WORKING" }, fauxToolCall("bash", { command: "sleep 2; echo TOOL-SLEPT" })], stopReason: "toolUse", outputTokens: 13 },
    { content: [{ type: "text", text: "AFTER-TOOL" }], stopReason: "stop", outputTokens: 3 },
  ];
  pi.registerProvider("epi-faux-late", {
    baseUrl: "http://localhost:0",
    apiKey: "faux-test-key",
    api: "faux-late",
    streamSimple: (model) => {
      const script = scripts.shift();
      if (script === undefined) throw new Error("No more scripted responses");
      return streamScripted(model, script.content, script.stopReason, script.outputTokens);
    },
    models: [{ id: "model-a", name: "model-a", reasoning: false, input: ["text"], cost: zeroUsage.cost, contextWindow: 128000, maxTokens: 16384 }],
  });
}
