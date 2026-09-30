// Faux model whose first reply calls a one-second bash tool and whose second streams slowly, plus a
// session_shutdown handler that takes 2.5 s: quitting during the tool means the next turn_start
// arrives after the TUI stopped, while shutdown is still running.
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  registerFaux(pi, {
    models: ["tool"],
    tokensPerSecond: 20,
    responses: [
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText(`SECOND-TURN ${long}`)),
    ],
  });
  pi.on("session_shutdown", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
}
