// Dogfood D1: a provider extension that forgets `cost` on its model. Otherwise the same faux echo
// model faux-register.mjs registers, under its own provider id so the two never collide. The faux
// core itself never prices a reply, so streamSimple first calls pi-ai's calculateCost the way every
// real provider does once it has usage -- where the missing cost used to fail.
import { calculateCost, createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const usage = () => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export default function (pi) {
  const core = createFauxCore({ provider: "epi-nocost", models: [{ id: "echo" }] });
  core.setResponses([() => fauxAssistantMessage(fauxText("ECHO"))]);
  pi.registerProvider("epi-nocost", {
    baseUrl: "http://localhost:0",
    apiKey: "faux-test-key",
    api: core.api,
    streamSimple: (model, context, options) => {
      calculateCost(model, usage());
      return core.streamSimple(model, context, options);
    },
    models: core.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ["text"],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
}
