// Registers a scripted faux model as an ordinary configured provider (with an API key), not as a
// native provider: Pi marks configured providers as authenticated synchronously, while a native
// provider's auth only lands after an un-awaited background refresh, which races the first prompt.
import { createFauxCore } from "@earendil-works/pi-ai";

export function registerFaux(pi, { models, responses, tokensPerSecond }) {
  const core = createFauxCore({
    provider: "mmp-faux",
    models: models.map((id) => ({ id })),
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  });
  core.setResponses(responses);
  pi.registerProvider("mmp-faux", {
    baseUrl: "http://localhost:0",
    apiKey: "faux-test-key",
    api: core.api,
    streamSimple: core.streamSimple,
    models: core.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: false,
      input: ["text"],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
}
