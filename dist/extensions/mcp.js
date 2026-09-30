import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpExtension, } from "@earendil-works/pi-coding-agent";
// Native MCP (docs/mcp-design.md, decision MCP2): MMP no longer ships its own MCP client
// (pi-mcp-adapter, removed in the Pi 0.99 upgrade's stage 1) -- Pi's own createMcpExtension does
// connections, OAuth, tool registration, and the /mcp panel. MMP only decides *which config files*
// get read and *whose trust judgment* gates the project one (never Pi's own .pi/ or
// ctx.isProjectTrusted() -- that is Pi's own trust store, and MMP always runs Pi with --no-approve).
// pi-internals row `mcp-native-config-loader`: extensions/mcp/config.js's loadMcpConfig is not in
// pi-coding-agent's package "exports" map (design §2), so it is imported by file path, like
// src/tui/keybindings.ts imports core/keybindings.js. Top-level await: this runs once, when
// src/extensions/index.ts's static import of this module is first evaluated, mirroring
// keybindings.ts (config.js only touches node:fs/node:path plus two other Pi core modules -- no
// heavier than that, unlike runtime.js, which Pi itself keeps lazy for exactly this reason).
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadMcpConfig: piLoadMcpConfig } = (await import(pathToFileURL(join(piDist, "extensions", "mcp", "config.js")).href));
/**
 * Reads `~/.mmp/mcp.json`, and, only when MMP trusts the current project
 * (`assembly.projectManifest?.loaded === true` -- MMP's own trust judgment, never
 * `ctx.isProjectTrusted()`), also `<project>/.mmp/mcp.json`. Both calls reuse Pi's own
 * `loadMcpConfig` with `projectTrusted: false` (design §2): that flag only controls whether
 * `loadMcpConfig` itself additionally reads `<cwd>/.pi/mcp.json`, which MMP never wants, so it is
 * always false, and the two files MMP does want are read by varying `agentDir` instead. The second
 * call's entries are relabeled `scope: "project"` (Pi's own `loadMcpConfig` calls them "global"
 * because, from its point of view, `<project>/.mmp` was just another `agentDir`); on a name clash
 * the project entry wins, matching Pi's own project-overrides-global rule.
 */
export function loadNativeMcpConfig(source, cwd) {
    const assembly = source.resolveAssembly();
    const global = piLoadMcpConfig({ agentDir: source.mmpHome, cwd, projectTrusted: false });
    if (assembly.projectManifest?.loaded !== true) {
        return global;
    }
    const projectAgentDir = join(assembly.projectManifest.root, ".mmp");
    const project = piLoadMcpConfig({ agentDir: projectAgentDir, cwd, projectTrusted: false });
    const merged = new Map(global.servers.map((entry) => [entry.name, entry]));
    for (const entry of project.servers) {
        merged.set(entry.name, { ...entry, scope: "project" });
    }
    const autoEnableCodemode = project.autoEnableCodemode ?? global.autoEnableCodemode;
    return {
        servers: [...merged.values()],
        ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }),
        errors: [...global.errors, ...project.errors],
    };
}
function isServerEnabled(entry) {
    return entry.config.enabled !== false;
}
function emptyStateMessage(mmpHome) {
    return (`No MCP servers configured. Add them to ${join(mmpHome, "mcp.json")} ` +
        `or .mmp/mcp.json in a trusted project, then run \`mmp mcp add\`.`);
}
const DUPLICATE_MCP_COMMAND_MESSAGE = "Another extension in the Manifest also registers \"/mcp\" alongside mmp:mcp. Pi's builtin-" +
    "replace mechanism does not apply to MMP's inline extensions, so both would silently rename to " +
    "\"/mcp:1\"/\"/mcp:2\" -- declare only one MCP integration in the Manifest.";
/** `pi.getCommands()` returns each command's final, post-collision invocation name (private
 * disambiguation in Pi's `ExtensionRunner.resolveRegisteredCommands`): when two extensions both
 * register "mcp", Pi renames *both* to "mcp:1"/"mcp:2" rather than keeping one plain "mcp" --
 * verified in `core/extensions/runner.js`. That is MMP's signal to fail visibly (docs/mcp-design.md
 * §4): a Manifest that declares another extension registering "/mcp" alongside "mmp:mcp". */
function hasDuplicateMcpCommand(pi) {
    return pi.getCommands().some((command) => /^mcp:\d+$/.test(command.name));
}
/**
 * `mmp:mcp`: `createMcpExtension` (connections, OAuth, tool registration, `/mcp`) wired to MMP's own
 * config source, plus two MMP-only behaviors Pi has no hook for:
 *   - `/mcp` with zero configured servers shows MMP's own message instead of Pi's (which names
 *     `.pi/mcp.json`, a path MMP never reads) -- done by wrapping the `pi` passed into Pi's factory
 *     so only the "mcp" registration is intercepted; every other call passes through untouched.
 *   - a Manifest that (mis)declares a second extension also registering "/mcp" fails visibly at
 *     `session_start` instead of silently producing "/mcp:1"/"/mcp:2".
 *
 * `credentials` is intentionally left to Pi's default rather than passed explicitly: its type is
 * `McpOAuthCredentialStore` (a class instance with a private `AuthStorageBackend`, not a path --
 * verified in `extensions/mcp/oauth.d.ts`), and constructing one only to point it at the same
 * location Pi already defaults to would import `oauth.js` for no isolation benefit. Pi's default
 * resolves through `getAgentDir()`, which MMP already redirects globally (`src/host.ts` sets
 * `PI_CODING_AGENT_DIR` to MMP's own `<mmpHome>/pi` before Pi ever runs), so the default already
 * lands at `<mmpHome>/pi/mcp-auth.json` -- test/mcp.test.mjs asserts this. `logPath` has no such
 * default-already-correct shortcut concern (it is a plain string), so it is passed explicitly for
 * auditability, matching the design.
 */
export function createMmpMcpExtension(source) {
    const { mmpHome, resolveAssembly } = source;
    const loadConfig = (ctx) => loadNativeMcpConfig(source, ctx.cwd);
    const logPath = join(mmpHome, "pi", "mcp.log");
    const piFactory = createMcpExtension({ loadConfig, logPath });
    return {
        name: "mmp:mcp",
        factory: async (pi) => {
            const wrappedPi = new Proxy(pi, {
                get(target, prop, _receiver) {
                    if (prop === "registerCommand") {
                        return (name, commandOptions) => {
                            if (name !== "mcp") {
                                return target.registerCommand(name, commandOptions);
                            }
                            return target.registerCommand(name, {
                                ...commandOptions,
                                handler: async (args, ctx) => {
                                    if (args.trim().length === 0) {
                                        const enabledCount = loadConfig(ctx).servers.filter(isServerEnabled).length;
                                        if (enabledCount === 0) {
                                            ctx.ui.notify(emptyStateMessage(mmpHome), "info");
                                            return;
                                        }
                                    }
                                    return commandOptions.handler(args, ctx);
                                },
                            });
                        };
                    }
                    return Reflect.get(target, prop, target);
                },
            });
            await piFactory(wrappedPi);
            pi.on("session_start", (_event, ctx) => {
                if (hasDuplicateMcpCommand(pi)) {
                    // Verified empirically (not just from source), across both modes MMP tests directly:
                    // - print (`-p`) mode: ctx.ui.notify is a no-op (modes/print-mode.js's bindExtensions call
                    //   passes no uiContext), so only a thrown error is visible there -- caught by Pi's own
                    //   per-handler try/catch (core/extensions/runner.js's emit()) and routed to onError,
                    //   which print mode wires to console.error.
                    // - MMP's own TUI (src/tui/app.ts): ctx.ui.notify *does* work (mapped straight to
                    //   transcript.notice, the same sink app.ts's onError uses) and renders a persistent
                    //   banner. ctx.shutdown() calls app.ts's shutdownHandler, `() => void exit(0)` --
                    //   deliberately NOT called here: calling it before the throw would race the transcript
                    //   render against process exit, and a running-but-visibly-warned session is a better
                    //   outcome than a session that may exit before anyone reads why.
                    // Neither channel alone covers every mode MMP runs Pi in (print, TUI, RPC, json, SDK), so
                    // both fire; this does not by itself change the exit code in print mode (documented in
                    // docs/mcp-design.md §4, not silently assumed).
                    ctx.ui.notify(DUPLICATE_MCP_COMMAND_MESSAGE, "error");
                    throw new Error(DUPLICATE_MCP_COMMAND_MESSAGE);
                }
            });
        },
    };
}
//# sourceMappingURL=mcp.js.map