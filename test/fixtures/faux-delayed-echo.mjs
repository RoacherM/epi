// Faux model that echoes the latest user message back, prefixed, after a delay like a real model's
// latency ($MMP_TEST_FAUX_DELAY_MS, default 1500 ms): an MCP server connecting in the background
// has settled by the time the run ends, which the instant faux-echo.mjs does not give it.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

function lastUserText(context) {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

export default function (pi) {
  registerFaux(pi, {
    models: ["delayed"],
    responses: [
      async (context, options) => {
        await pause(Number(process.env.MMP_TEST_FAUX_DELAY_MS ?? 1500), options?.signal);
        return fauxAssistantMessage(fauxText(`ECHO:${lastUserText(context)}`));
      },
    ],
  });
}
