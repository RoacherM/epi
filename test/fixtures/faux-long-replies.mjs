// Faux model whose replies are each taller than a 40-row screen, so a transcript of two turns
// scrolls: reply N opens with `REPLY-N`, names `MARKER-N` on its second line, then 50 filler lines.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

const reply = (n) => fauxAssistantMessage([`REPLY-${n}`, "", `MARKER-${n} is here`, "", ...Array.from({ length: 50 }, (_, i) => `- filler ${n}.${i}`)].join("\n"));

export default function (pi) {
  registerFaux(pi, { models: ["long"], responses: [reply(1), reply(2), reply(3)] });
}
