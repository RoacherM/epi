// Registers /marker (always), /late (only from the second invocation onward) and an echo model.
// /reload calls session.reload(), which reloads resources and re-runs every extension factory
// (see resource-loader.js's loadExtensionFactories) even though the AgentSession instance stays
// the same. A test can use this to prove Epi's /reload handler reaches that path, refreshes the
// autocomplete command list, and leaves the model usable (re-registering the faux provider on
// reload must not break it).
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

let calls = 0;

export default function (pi) {
  calls += 1;
  const count = calls;
  registerFaux(pi, {
    models: ["echo"],
    responses: [(context) => fauxAssistantMessage(fauxText(`ECHO:${lastUserText(context)}`))],
  });
  pi.registerCommand("marker", {
    description: "reports how many times this extension has loaded",
    handler: async (_args, ctx) => ctx.ui.notify(`MARKER-CALL-${count}`, "info"),
  });
  if (calls > 1) {
    pi.registerCommand("late", {
      description: "only exists after reload",
      handler: async () => {},
    });
  }
}
