// Faux model with two distinct canned replies, consumed in order across separate sessions too
// (the faux provider's response queue is shared by the whole process, not per-session).
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["replies"], responses: [fauxAssistantMessage("FIRST-REPLY"), fauxAssistantMessage("SECOND-REPLY")] });
}
