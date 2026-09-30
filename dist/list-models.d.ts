import { type InlineExtension } from "@earendil-works/pi-coding-agent";
type ListedModel = {
    provider: string;
    id: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: readonly string[];
};
export declare const NO_MODELS_MESSAGE: string;
/** Whether piMain would take its `--list-models` branch for these args: it checks `--export` first
 * (and `--help`/`--version`, which MMP already handles before reaching here). */
export declare function isListModelsRun(piArgs: readonly string[]): boolean;
/** Pi's cli/list-models.js table: sorted by provider then id, space-padded columns. */
export declare function formatModelTable(models: readonly ListedModel[]): string;
export declare function runListModels(piArgs: readonly string[], options: {
    cwd: string;
    agentDir: string;
    externalExtensionPaths: string[];
    extensionFactories: InlineExtension[];
}): Promise<void>;
export {};
//# sourceMappingURL=list-models.d.ts.map