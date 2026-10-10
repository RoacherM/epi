// D83: the selected provider fails on the second factory call, then recovers on the third.
export default function (pi) {
  const loads = Number(process.env.EPI_TEST_PROVIDER_LOADS ?? 0) + 1;
  process.env.EPI_TEST_PROVIDER_LOADS = String(loads);
  if (loads === 2) throw new Error("D83 provider reload failed");
  pi.registerProvider("selected", {
    baseUrl: "http://localhost:0",
    apiKey: "fixture-key",
    api: "openai-completions",
    models: [{
      id: "chosen", name: "Chosen", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000, maxTokens: 1000,
    }],
  });
}
