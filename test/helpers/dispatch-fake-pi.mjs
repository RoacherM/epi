// A minimal stand-in for Pi's ExtensionAPI and ExtensionContext, enough to drive the dispatch
// extension's handlers offline: `emit` runs every handler for an event in registration order and
// returns their results; `sent` and `appended` record what the extension asked Pi to persist.
export function createFakePi({ sessionId = "sess-1", mode = "print", branch = [] } = {}) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const appended = [];
  let idle = true;
  const entries = [...branch];
  const ctx = {
    mode,
    hasUI: false,
    cwd: process.cwd(),
    ui: { notify() {}, setStatus() {} },
    isIdle: () => idle,
    signal: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, options) { commands.set(name, options); },
    sendMessage(message, options) { sent.push({ message, options }); },
    appendEntry(customType, data) {
      appended.push({ customType, data });
      entries.push({ type: "custom", customType, data, id: `e${entries.length}` });
    },
    events: { emit() {}, on() { return () => {}; } },
  };
  return {
    pi, ctx, tools, commands, sent, appended, entries,
    setIdle(value) { idle = value; },
    async emit(event, payload = {}) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
      return results;
    },
    has(event) { return (handlers.get(event) ?? []).length > 0; },
  };
}

export async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}
