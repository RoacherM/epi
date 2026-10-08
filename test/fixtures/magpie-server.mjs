import { createServer } from "node:http";

export const magpieCatalog = [
  { id: "claude/claude-opus-test", display_name: "Claude Test", context_window: 1000000, max_output_tokens: 16384, modalities: { input: ["text", "image"] }, reasoning: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }] },
  { id: "codex/gpt-test", native_endpoints: ["/v1/responses"], context_window: 272000, max_output_tokens: 8192, reasoning: true },
  { id: "antigravity/gemini-3-flash", context_window: 1000000, max_output_tokens: 8192 },
  { id: "other/chat", native_endpoints: ["/v1/chat/completions"] },
];

function anthropicEvents(model, toolCall) {
  const events = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: toolCall ? { type: "tool_use", id: "tool_test", name: "echo", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: toolCall ? { type: "input_json_delta", partial_json: '{"value":"你好"}' } : { type: "text_delta", text: "MAGPIE_OK 你好" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function responsesEvents(model) {
  const item = { id: "item_test", type: "message", role: "assistant", content: [], status: "in_progress" };
  const part = { type: "output_text", text: "", annotations: [] };
  const response = { id: "resp_test", model, status: "in_progress", output: [] };
  const events = [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "MAGPIE_OK 你好" },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "MAGPIE_OK 你好" },
    { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", content: [{ ...part, text: "MAGPIE_OK 你好" }] } },
    { type: "response.completed", response: { ...response, status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export async function startMagpieServer() {
  const state = { catalog: structuredClone(magpieCatalog), requests: [], catalogStatus: 200, catalogBody: undefined, catalogHandler: undefined, hang: false, toolCall: false, hangInference: false, malformedStream: false, inferenceStatus: 200, inferenceError: "prompt is too long: context_length_exceeded" };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const parsed = body ? JSON.parse(body) : undefined;
    state.requests.push({ url: request.url, headers: request.headers, body: parsed });
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/v1/models") {
      if (state.catalogHandler) return state.catalogHandler(request, response);
      if (state.hang) return;
      response.writeHead(state.catalogStatus, { "content-type": "application/json" });
      response.end(state.catalogBody ?? JSON.stringify({ data: state.catalog, has_more: false }));
      return;
    }
    if (state.hangInference) return;
    if (state.inferenceStatus !== 200) {
      response.writeHead(state.inferenceStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: state.inferenceError } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (state.malformedStream) return response.end('event: message_start\ndata: {bad-json}\n\n');
    if (path === "/v1/messages") {
      response.end(anthropicEvents(parsed.model, state.toolCall));
    } else if (path === "/v1/responses") {
      response.end(responsesEvents(parsed.model));
    } else if (path === "/v1/chat/completions") {
      const events = [
        { id: "chat_test", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: { role: "assistant", content: "MAGPIE_OK 你好" }, finish_reason: null }] },
        { id: "chat_test", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ];
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    } else if (path.startsWith("/v1beta/models/")) {
      response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "MAGPIE_OK 你好" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`);
    } else {
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
