import { type ProviderConfig } from "@earendil-works/pi-coding-agent";
/** The first model in `config.models` whose `cost` is missing or lacks a numeric rate, described
 * the way Pi words its own registration errors (`Provider <id>, model <id>: ...`). */
export declare function providerCostProblem(providerId: string, config: ProviderConfig): string | undefined;
export declare function installProviderCostValidation(): void;
//# sourceMappingURL=provider-validation.d.ts.map