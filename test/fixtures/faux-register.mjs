// Registers a scripted faux model as an ordinary configured provider (with an API key), not as a
// native provider: Pi marks configured providers as authenticated synchronously, while a native
// provider's auth only lands after an un-awaited background refresh, which races the first prompt.
import { createFauxCore } from "@earendil-works/pi-ai";

// A scripted response's delay that ends early when the request is aborted (a response function
// gets the request's stream options second). It resolves rather than throws: the faux core then
// sees the aborted signal and ends the stream as "aborted", like a real provider would, instead of
// reporting the abort as a provider error.
export function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function registerFaux(pi, { models, responses, tokensPerSecond, reasoning = false }) {
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
      reasoning,
      input: ["text"],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
}
