// Two reasoning-capable faux models, for the per-model thinking level tests (D29).
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["thinker-a", "thinker-b"], reasoning: true, responses: [] });
}
