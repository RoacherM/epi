// Two faux models; the answer names the model Pi actually picked.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const answer = (_context, _options, _state, model) => fauxAssistantMessage(`PICKED=${model.id}`);
  registerFaux(pi, { models: ["model-a", "model-b"], responses: [answer, answer] });
}
