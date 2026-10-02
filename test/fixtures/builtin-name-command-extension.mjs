// Test-only commands: `/session` takes a built-in's name (the built-in must win, like Pi) and
// `/extonly` has a name no built-in uses (the extension's handler must run).
export default function (pi) {
  pi.registerCommand("session", {
    description: "shadowed by the built-in /session",
    handler: async (_args, ctx) => ctx.ui.notify("EXT-SESSION-RAN", "info"),
  });
  pi.registerCommand("extonly", {
    description: "an extension command no built-in shadows",
    handler: async (args, ctx) => ctx.ui.notify(`EXTONLY-RAN:${args}`, "info"),
  });
}
