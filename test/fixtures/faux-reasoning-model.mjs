// Reasoning-capable faux model, for the /thinking tests (getAvailableThinkingLevels needs
// model.reasoning to return more than just "off").
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["thinker"], reasoning: true, responses: [] });
}
