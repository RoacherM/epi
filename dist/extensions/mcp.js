import { existsSync } from "node:fs";
import { createRequire } from "node:module";
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
// keybindings.ts (config.js only touches node:fs/node:path plus two other Pi core modules).
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadMcpConfig: piLoadMcpConfig } = (await import(pathToFileURL(join(piDist, "extensions", "mcp", "config.js")).href));
// pi-internals row `mcp-default-transport`: runtime.js's createDefaultTransport (not in the package
// "exports" map; only the McpTransportFactory type is) is what createMcpExtension uses when no
// createTransport option is given. Loaded at the first transport, not before (dogfood D42): Pi
// itself loads runtime.js only once a session has servers (index.js's loadMcpRuntime), and
// src/commands/mcp-cli.ts imports this module too, so `mmp mcp add/remove` must not load it either
// (row `mcp-native-runtime`). Pi only ever calls createTransport synchronously from inside runtime.js
// (McpServerConnection.connectOnce), so by then runtime.js is evaluated and require() of the ES
// module returns that same instance at once. The mmp:mcp factory still checks the file exists, so
// a moved path fails loudly at startup rather than at the first connect.
const piRuntimePath = join(piDist, "extensions", "mcp", "runtime.js");
let piCreateDefaultTransport;
function checkDefaultTransportPath() {
    if (!existsSync(piRuntimePath)) {
        throw new Error(`mmp:mcp: Pi's MCP runtime is not at ${piRuntimePath} (pi-internals row mcp-default-transport)`);
    }
}
function defaultTransportFactory() {
    if (piCreateDefaultTransport === undefined) {
        const { createDefaultTransport } = createRequire(import.meta.url)(piRuntimePath);
        if (typeof createDefaultTransport !== "function") {
            throw new Error(`mmp:mcp: ${piRuntimePath} no longer exports createDefaultTransport (pi-internals row mcp-default-transport)`);
        }
        piCreateDefaultTransport = createDefaultTransport;
    }
    return piCreateDefaultTransport;
}
/**
 * Pi's default transport factory, plus a record of every transport it made that has not closed yet.
 * Dogfood D3: Pi's `McpServerConnection.close()` (extensions/mcp/runtime.js) only closes a client
 * that finished `initialize`; a connect still in flight keeps its client and transport in
 * `connectOnce()`'s locals, so a server that never answers keeps the child process, its pipes and
 * the request timer alive until the request timeout (60 s by default) -- `mmp -p` printed its
 * answer and then sat there. Closing the transport rejects the pending `initialize`
 * (pi-mcp client.js `handleTransportClose` -> `markClosed`), and Pi's connection, already marked
 * closed by then, settles as "closed". Same upstream as of Pi 0.99.2.
 */
function trackingTransportFactory() {
    const open = new Set();
    return {
        createTransport: (entry, cwd, authProvider) => {
            const transport = defaultTransportFactory()(entry, cwd, authProvider);
            open.add(transport);
            transport.onClose(() => open.delete(transport));
            return transport;
        },
        async closeAll() {
            const closing = [...open];
            open.clear();
            // Transport close() is idempotent; ones Pi already closed return at once.
            await Promise.all(closing.map((transport) => transport.close().catch(() => undefined)));
        },
    };
}
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
function emptyStateMessage(mmpHome) {
    return (`No MCP servers configured. Add them to ${join(mmpHome, "mcp.json")} ` +
        `or .mmp/mcp.json in a trusted project, then run \`mmp mcp add\`.`);
}
/**
 * One stderr line per enabled MCP server that needs attention, read from Pi's own per-server state
 * without waiting for anything. The state comes from the "/mcp" command's own completions for
 * `reconnect ` (`extensions/mcp/index.js`): one item per server that has a connection, labelled with
 * its name and described by Pi's private `describeState()` -- `failed: <first error line>`,
 * `needs sign-in`, `connecting…`, `connected · N tools`. Healthy servers produce nothing (no false
 * alarm). A server still connecting -- or one without a connection yet because Pi's MCP runtime has
 * not even loaded -- gets a "still connecting" line. Config errors are not reported here: those
 * already fail eagerly before Pi starts (`buildInlineExtensions` throwing `MmpConfigError`,
 * docs/mcp-design.md §2).
 */
async function mcpProblemLines(completions, enabledServerNames) {
    const states = new Map(((await completions("reconnect ")) ?? []).map((item) => [item.label, item.description ?? ""]));
    const lines = [];
    for (const name of new Set([...enabledServerNames, ...states.keys()])) {
        const state = states.get(name);
        if (state === undefined || state.startsWith("connecting")) {
            lines.push(`mcp: ${name} is still connecting; its tools become available once connected`);
        }
        else if (state.startsWith("failed") || state.startsWith("needs sign-in")) {
            lines.push(`${name}: ${state}`);
        }
    }
    return lines;
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
 * config source, plus three MMP-only behaviors:
 *   - `/mcp` with zero configured servers shows MMP's own message instead of Pi's (which names
 *     `.pi/mcp.json`, a path MMP never reads) -- done by wrapping the `pi` passed into Pi's factory
 *     so only the "mcp" registration is intercepted; every other call passes through untouched.
 *   - a Manifest that (mis)declares a second extension also registering "/mcp" fails visibly at
 *     `session_start` instead of silently producing "/mcp:1"/"/mcp:2".
 *   - a server still connecting when the session shuts down is closed instead of holding the
 *     process open until its request timeout (dogfood D3, `trackingTransportFactory`).
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
    const transports = trackingTransportFactory();
    const piFactory = createMcpExtension({ loadConfig, logPath, createTransport: transports.createTransport });
    return {
        name: "mmp:mcp",
        factory: async (pi) => {
            // F3 (Fable milestone review, hard rule 3): captured so before_agent_start below can read
            // each server's state, in non-TUI modes, to surface a connection failure, a pending sign-in,
            // or a server still connecting that Pi's own ctx.ui.notify would otherwise drop silently
            // (verified empirically: ctx.ui.notify is a no-op in print/json mode -- modes/print-mode.js's
            // bindExtensions passes no uiContext).
            let piMcpCompletions;
            const wrappedPi = new Proxy(pi, {
                get(target, prop, _receiver) {
                    if (prop === "registerCommand") {
                        return (name, commandOptions) => {
                            if (name !== "mcp") {
                                return target.registerCommand(name, commandOptions);
                            }
                            piMcpCompletions = commandOptions.getArgumentCompletions;
                            return target.registerCommand(name, {
                                ...commandOptions,
                                handler: async (args, ctx) => {
                                    if (args.trim().length === 0) {
                                        // Fable milestone review, F2: this used to count only *enabled* configured
                                        // servers, so disabling the only server (or having servers solely from
                                        // pi.registerMcpServer(), e.g. another extension) hid Pi's real /mcp panel --
                                        // exactly the place a person would go to re-enable one. Count every configured
                                        // server regardless of `enabled`, plus anything registered via the extension
                                        // API (pi.getMcpServers()); MMP's message is only for a project with truly
                                        // nothing to show.
                                        const configuredCount = loadConfig(ctx).servers.length;
                                        const registeredCount = pi.getMcpServers().length;
                                        if (configuredCount === 0 && registeredCount === 0) {
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
            checkDefaultTransportPath();
            await piFactory(wrappedPi);
            // Registered after piFactory, so it runs after Pi's own session_shutdown handler has marked
            // every connection closed and closed the connected ones: what is left is a connect still in
            // flight (D3). Also covers /new and /reload, which shut the old session down the same way.
            pi.on("session_shutdown", () => transports.closeAll());
            pi.on("session_start", () => {
                if (hasDuplicateMcpCommand(pi)) {
                    // Verified empirically (not just from source): throwing here is the one channel that
                    // posts exactly once in every mode MMP runs Pi in. Every mode's bindExtensions wires an
                    // onError, and Pi's own per-handler try/catch (core/extensions/runner.js's emit()) routes
                    // a thrown session_start error there -- print mode's onError does console.error (visible
                    // on stderr; print mode passes no uiContext, so ctx.ui.notify would be a silent no-op
                    // there anyway), MMP's TUI (src/tui/app.ts) does transcript.notice (a persistent banner).
                    // Calling ctx.ui.notify as well, in addition to throwing, used to double-post in the TUI:
                    // both notify and onError land in the same transcript.notice sink there. ctx.shutdown() is
                    // also not called: it calls app.ts's shutdownHandler (`() => void exit(0)`) in the TUI,
                    // which would race the banner's render against process exit -- a running-but-visibly-
                    // warned session is a better outcome than one that may exit before anyone reads why. None
                    // of this changes the exit code in print mode (documented in docs/mcp-design.md §4, not
                    // silently assumed).
                    throw new Error(DUPLICATE_MCP_COMMAND_MESSAGE);
                }
            });
            // F3: in the TUI, a connection failure or pending sign-in is already visible (Pi's own
            // reportProblems() reaches a real ctx.ui.notify there, and /mcp's panel shows it too). In
            // print and json mode ctx.ui.notify is a no-op, so MMP writes the problem servers to stderr
            // itself; stdout is never touched, since -p and --mode json consumers read it.
            //
            // When: at the first before_agent_start of a session, *after* Pi's own handler for the same
            // event. Pi's handler (registered inside piFactory above, so it runs first: the runner awaits
            // one extension's handlers in registration order) waits for the startup connections, bounded
            // by createMcpExtension's startupWaitMs (Pi's default, 10 s, since MMP passes none). So by
            // the time this runs, every server has either settled or is still connecting past Pi's bound,
            // and reading the state is instant -- MMP adds no wait of its own. Doing the check at
            // session_start instead would wait before the prompt starts, and then Pi's own timer would
            // start from zero on top of that, doubling the bound for a hung server. Nothing is left
            // running after this handler returns, so a server that settles later cannot print anything.
            let reportedThisSession = false;
            pi.on("session_start", () => {
                reportedThisSession = false;
            });
            pi.on("before_agent_start", async (_event, ctx) => {
                if (ctx.mode === "tui" || reportedThisSession || piMcpCompletions === undefined)
                    return;
                reportedThisSession = true;
                const configured = loadConfig(ctx).servers.filter((entry) => entry.config.enabled !== false);
                const registered = pi.getMcpServers().filter((server) => server.config.enabled !== false);
                const enabledServerNames = [...configured, ...registered].map((server) => server.name);
                const lines = await mcpProblemLines(piMcpCompletions, enabledServerNames);
                if (lines.length > 0) {
                    process.stderr.write(`${lines.join("\n")}\n`);
                }
            });
        },
    };
}
//# sourceMappingURL=mcp.js.map