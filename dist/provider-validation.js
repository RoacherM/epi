import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// Dogfood D1: Pi 0.99.1 types every model's `cost` as required (`BaseModel.cost: ModelCost`) but
// never checks it -- `validateExtensionProvider` (core/model-runtime.js) only checks `api` and
// `baseUrl`, and `extensionModelFromDefinition` spreads the definition as is, with no default
// (unlike models.json's `modelFromJson`, which fills in zero cost). A model registered through
// `pi.registerProvider` without it registers fine and then fails on the first reply, inside
// pi-ai's `calculateCost`, with only "Cannot read properties of undefined (reading 'tiers')".
//
// pi-internals row `model-runtime-register-provider`: Epi checks the costs first by wrapping
// `ModelRuntime.prototype.registerProvider` (every Pi entry point -- main.js, the SDK,
// agent-session-services.js -- imports the one core/model-runtime.js module). A throw there is
// what Pi already does for a missing `api`/`baseUrl`, so Pi reports it the same way: when
// registrations queued during extension loading are applied, as `Extension "<path>" error: ...`
// (a startup diagnostic; print/json mode stops on it) or through the extension runner's error
// channel with the extension's path; after that, the throw reaches the extension's own
// `pi.registerProvider` call. The provider is not registered. No default is filled in.
const COST_RATES = ["input", "output", "cacheRead", "cacheWrite"];
function isRate(value) {
    return typeof value === "number" && Number.isFinite(value);
}
/** The first model in `config.models` whose `cost` is missing or lacks a numeric rate, described
 * the way Pi words its own registration errors (`Provider <id>, model <id>: ...`). */
export function providerCostProblem(providerId, config) {
    for (const definition of (config.models ?? [])) {
        const model = `Provider ${providerId}, model ${String(definition.id)}`;
        const cost = definition.cost;
        if (typeof cost !== "object" || cost === null) {
            return (`${model}: no "cost" specified. Set its per-million-token rates: ` +
                `cost: { input, output, cacheRead, cacheWrite } (numbers).`);
        }
        const missing = COST_RATES.filter((rate) => !isRate(cost[rate]));
        if (missing.length > 0) {
            return `${model}: "cost" needs a number for ${missing.map((rate) => `"${rate}"`).join(", ")}.`;
        }
    }
    return undefined;
}
let installed = false;
export function installProviderCostValidation() {
    if (installed)
        return;
    installed = true;
    const prototype = ModelRuntime.prototype;
    const registerProvider = prototype.registerProvider;
    if (typeof registerProvider !== "function") {
        throw new Error("epi: Pi's ModelRuntime.prototype.registerProvider is gone (docs/pi-internals.md model-runtime-register-provider)");
    }
    prototype.registerProvider = function (providerId, config) {
        const problem = providerCostProblem(providerId, config);
        if (problem !== undefined) {
            throw new Error(problem);
        }
        return registerProvider.call(this, providerId, config);
    };
}
//# sourceMappingURL=provider-validation.js.map