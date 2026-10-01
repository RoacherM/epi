// Faux model that streams slowly, so a test can abort mid-response.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  registerFaux(pi, {
    models: ["slow"],
    tokensPerSecond: 20,
    responses: [fauxAssistantMessage(`SLOW-START ${long} SLOW-END`), fauxAssistantMessage("SECOND-REPLY")],
  });
}
