import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedAssembly } from "./assembly.js";
/** Whether piMain would take its `--list-models` branch for these args: it checks `--export` first
 * (and `--help`/`--version`, which MMP already handles before reaching here). */
export declare function isListModelsRun(piArgs: readonly string[]): boolean;
export declare function runListModels(piArgs: readonly string[], options: {
    cwd: string;
    agentDir: string;
    assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions" | "externalExtensions">;
    extensionFactories: InlineExtension[];
}): Promise<void>;
//# sourceMappingURL=list-models.d.ts.map