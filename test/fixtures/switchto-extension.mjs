// Test-only `/switchto <path>` command: calls ctx.switchSession directly, the same
// ExtensionCommandContext action app.ts's bindExtensions wires to runtime.switchSession (guarded
// by project-guard.ts's crossProjectRefusal). Lets tests exercise that guard with an exact session
// path instead of driving the /resume picker.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

const echo = (context) => fauxAssistantMessage(fauxText(`ECHO:${lastUserText(context)}`));

export default function (pi) {
  registerFaux(pi, {
    models: ["echo"],
    // The faux queue is consumed once per model call (pi-ai's faux provider), not reused; tests
    // here send more than one real turn to the same running session, unlike most other fixtures.
    responses: Array.from({ length: 10 }, () => echo),
  });
  pi.registerCommand("switchto", {
    description: "test-only: calls ctx.switchSession with the given path",
    handler: async (args, ctx) => {
      // ctx becomes stale the instant switchSession actually replaces the session (Pi throws if
      // it's touched afterward); only notify in the refused case, where ctx is still the live one.
      const result = await ctx.switchSession(args.trim());
      if (result.cancelled) ctx.ui.notify("SWITCH-CANCELLED", "info");
    },
  });
}
