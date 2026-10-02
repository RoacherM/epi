// Two reasoning-capable faux models that answer, so a test can seed a session with history and
// then check which thinking level a later start (--continue) ends up with.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const answer = () => fauxAssistantMessage("OK");
  registerFaux(pi, { models: ["thinker-a", "thinker-b"], reasoning: true, responses: [answer, answer] });
}
