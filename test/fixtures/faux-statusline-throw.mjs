// A faux model plus an extension whose status line formatter throws: the app must fall back to
// the built-in default and say so, not let a render-time exception take the screen down.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["model-a"], responses: [fauxAssistantMessage("THROW-OK")] });
  pi.on("session_start", (_event, context) => {
    context.ui.setStatusLine(() => {
      throw new Error("boom");
    });
  });
}
