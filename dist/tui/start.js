import { parseArgs } from "@earendil-works/pi-coding-agent";
import { passthroughHasFlag } from "../args.js";
import { buildInlineExtensions } from "../extensions/index.js";
import { createPreviewInlineExtension } from "../extensions/preview.js";
import { buildTuiInitialMessages } from "../file-arguments.js";
import { findNearestProjectManifest } from "../project.js";
import { runTuiApp } from "./app.js";
import { createEpiRuntime } from "./services.js";
import { detectAppearance, installEpiTheme } from "./theme.js";
/** Extensions that are interface features (/preview) load only for the interactive TUI: print,
 * json and rpc have no screen to put them on. They go before epi:system-prompt, which has to stay
 * last (extensions/index.ts). */
function withInterfaceExtensions(extensionFactories) {
    const last = extensionFactories.findIndex((extension) => extension.name === "epi:system-prompt");
    const at = last < 0 ? extensionFactories.length : last;
    return [...extensionFactories.slice(0, at), createPreviewInlineExtension(), ...extensionFactories.slice(at)];
}
/** The Manifest assembly, handed to the SDK. */
export async function createRuntimeFromPrepared(prepared, cwd, 
// Mirrors host.ts's own construction (same flag, same default undefined updateCheck) so a caller
// that builds a runtime straight from `prepared` (tests; host.ts always passes its own factories
// explicitly) still gets `--verbose` support.
extensionFactories = buildInlineExtensions(prepared.assembly, prepared.epiHome, prepared.runtimeIdentity, prepared.resolveAssembly, undefined, passthroughHasFlag(prepared.args.passthrough, "--verbose"))) {
    return createEpiRuntime({
        cwd,
        agentDir: prepared.agentDir,
        piArgs: prepared.args.passthrough,
        extensionFactories: withInterfaceExtensions(extensionFactories),
        externalExtensionPaths: prepared.assembly.externalExtensions.map((extension) => extension.value),
        assembly: prepared.assembly,
        projectIdentity: projectIdentityFromPrepared(prepared, cwd),
    });
}
/** The project this process assembled its manifest from (project-guard.ts): fixed for the whole
 * run, since manifest extensions cannot be hot-loaded (DEVELOPMENT.md §8.2).
 *
 * `root` is recomputed from `cwd` directly, independent of `--no-project`/trust: with
 * `--no-project` (or an untrusted/missing manifest), `prepared.assembly.projectManifest` is
 * undefined even when a `.epi/epi.json` really does exist above `cwd`, which made a session
 * started in that very folder look like "a different project" to project-guard.ts. */
export function projectIdentityFromPrepared(prepared, cwd) {
    return {
        root: findNearestProjectManifest(cwd, prepared.assembly.globalManifest)?.root,
        globalManifestPath: prepared.assembly.globalManifest,
    };
}
export async function startupOptionsFromPiArgs(piArgs, cwd) {
    const parsed = parseArgs([...piArgs]);
    const { messages: initialMessages, images: initialImages } = await buildTuiInitialMessages(parsed.fileArgs, parsed.messages, cwd);
    return {
        initialMessages,
        initialImages,
        resumeOnStart: parsed.resume === true &&
            parsed.session === undefined && parsed.continue !== true && parsed.noSession !== true,
    };
}
export async function runTuiV2(prepared, extensionFactories) {
    const cwd = process.cwd();
    // Pi's exported components read the global theme; it must exist before any of them is built.
    const theme = installEpiTheme(prepared.agentDir, detectAppearance(process.env));
    const runtime = await createRuntimeFromPrepared(prepared, cwd, extensionFactories);
    const { initialMessages, initialImages, resumeOnStart } = await startupOptionsFromPiArgs(prepared.args.passthrough, cwd);
    return runTuiApp({
        runtime,
        theme,
        cwd,
        agentDir: prepared.agentDir,
        logDirectory: prepared.agentDir,
        projectIdentity: projectIdentityFromPrepared(prepared, cwd),
        resumeOnStart,
        ...(initialMessages.length > 0 ? { initialMessages } : {}),
        ...(initialImages.length > 0 ? { initialImages } : {}),
    });
}
//# sourceMappingURL=start.js.map