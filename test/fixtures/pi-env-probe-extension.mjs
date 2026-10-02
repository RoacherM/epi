// Records, from inside a running mmp, what Pi's own code makes of the PI_* environment (dogfood
// D63, src/pi-env.ts). Writes MMP_PI_ENV_PROBE_OUT at session_start:
// - networkAllowed: what Pi passed as context.allowNetwork to this provider's refreshModels during
//   one refresh without an explicit allowNetwork, which takes Pi's ModelRuntime default: "online
//   unless PI_OFFLINE" (core/model-runtime.js). This refreshModels never touches the network.
// - hyperlinks: pi-tui's detectCapabilities(), which honours PI_HYPERLINKS.
// - env: every PI_* variable visible to Pi's code.
// The faux model answers "ok", so `-p` runs end without any real provider.
import { writeFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { detectCapabilities } from "@earendil-works/pi-tui";

export default function (pi) {
  const core = createFauxCore({ provider: "mmp-env-probe", models: [{ id: "probe" }] });
  core.setResponses([() => fauxAssistantMessage(fauxText("ok"))]);
  const models = core.models.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: false,
    input: ["text"],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
  let refreshContexts = [];
  pi.registerProvider("mmp-env-probe", {
    baseUrl: "http://localhost:0",
    apiKey: "probe-key",
    api: core.api,
    streamSimple: core.streamSimple,
    models,
    refreshModels: async (context) => {
      refreshContexts.push(context.allowNetwork);
      return models;
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    refreshContexts = [];
    await ctx.modelRegistry.refresh({ providers: ["mmp-env-probe"] });
    writeFileSync(
      process.env.MMP_PI_ENV_PROBE_OUT,
      JSON.stringify({
        networkAllowed: refreshContexts.includes(true),
        hyperlinks: detectCapabilities(() => false).hyperlinks,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("PI_"))),
      }),
    );
  });
}
