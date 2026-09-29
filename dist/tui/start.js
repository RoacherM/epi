// Entry of MMP's own interactive host (docs/tui-design.md). Gated behind MMP_TUI=v2 until it
// reaches parity; classic Pi interactive mode stays the default meanwhile.
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { buildInlineExtensions } from "../extensions/index.js";
import { runTuiApp } from "./app.js";
import { createMmpRuntime } from "./services.js";
import { detectAppearance, installMmpTheme } from "./theme.js";
/** Pi's resolveAppMode, plus the commands Pi's CLI handles itself (they stay on piMain). */
export function shouldUseTuiV2(environment, piArgs, stdinIsTTY, stdoutIsTTY) {
    if (environment.MMP_TUI !== "v2" || !stdinIsTTY || !stdoutIsTTY)
        return false;
    const parsed = parseArgs([...piArgs]);
    return parsed.mode === undefined && !parsed.print && !parsed.help &&
        parsed.listModels === undefined && parsed.export === undefined;
}
/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export async function createRuntimeFromPrepared(prepared, cwd, extensionFactories = buildInlineExtensions(prepared.assembly, prepared.mmpHome, prepared.runtimeIdentity, prepared.resolveAssembly)) {
    return createMmpRuntime({
        cwd,
        agentDir: prepared.agentDir,
        piArgs: prepared.args.passthrough,
        extensionFactories,
        externalExtensionPaths: prepared.assembly.externalExtensions.map((extension) => extension.value),
    });
}
export async function runTuiV2(prepared, extensionFactories) {
    const cwd = process.cwd();
    // Pi's exported components read the global theme; it must exist before any of them is built.
    const theme = installMmpTheme(prepared.agentDir, detectAppearance(process.env));
    const runtime = await createRuntimeFromPrepared(prepared, cwd, extensionFactories);
    return runTuiApp({ runtime, theme, cwd, logDirectory: prepared.agentDir });
}
//# sourceMappingURL=start.js.map