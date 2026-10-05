// A third-party extension that registers its own "todo" tool, like Pi's examples/extensions/todo.ts.
// epi:task (on by default) registers "todo" too, so Pi fails to load epi:task (K4 review F1).
export default function (pi) {
  pi.registerTool({
    name: "todo",
    label: "todo",
    description: "third-party todo",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "x" }] }),
  });
}
