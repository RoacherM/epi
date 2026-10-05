import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpExtension, } from "@earendil-works/pi-coding-agent";
// Native MCP (docs/mcp-design.md, decision MCP2): Epi no longer ships its own MCP client
// (pi-mcp-adapter, removed in the Pi 0.99 upgrade's stage 1) -- Pi's own createMcpExtension does
// connections, OAuth, tool registration, and the /mcp panel. Epi only decides *which config files*
// get read and *whose trust judgment* gates the project one (never Pi's own .pi/ or
// ctx.isProjectTrusted() -- that is Pi's own trust store, and Epi always runs Pi with --no-approve).
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
// src/commands/mcp-cli.ts imports this module too, so `epi mcp add/remove` must not load it either
// (row `mcp-native-runtime`). Pi only ever calls createTransport synchronously from inside runtime.js
// (McpServerConnection.connectOnce), so by then runtime.js is evaluated and require() of the ES
// module returns that same instance at once. The epi:mcp factory still checks the file exists, so
// a moved path fails loudly at startup rather than at the first connect.
const piRuntimePath = join(piDist, "extensions", "mcp", "runtime.js");
let piCreateDefaultTransport;
function checkDefaultTransportPath() {
    if (!existsSync(piRuntimePath)) {
        throw new Error(`epi:mcp: Pi's MCP runtime is not at ${piRuntimePath} (pi-internals row mcp-default-transport)`);
    }
}
function defaultTransportFactory() {
    if (piCreateDefaultTransport === undefined) {
        const { createDefaultTransport } = createRequire(import.meta.url)(piRuntimePath);
        if (typeof createDefaultTransport !== "function") {
            throw new Error(`epi:mcp: ${piRuntimePath} no longer exports createDefaultTransport (pi-internals row mcp-default-transport)`);
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
 * the request timer alive until the request timeout (60 s by default) -- `epi -p` printed its
 * answer and then sat there. Closing the transport rejects the pending `initialize`
 * (pi-mcp client.js `handleTransportClose` -> `markClosed`), and Pi's connection, already marked
 * closed by then, settles as "closed". Same upstream as of Pi 1.0.0.
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
 * Reads `~/.epi/mcp.json`, and, only when Epi trusts the current project
 * (`assembly.projectManifest?.loaded === true` -- Epi's own trust judgment, never
 * `ctx.isProjectTrusted()`), also `<project>/.epi/mcp.json`. Both calls reuse Pi's own
 * `loadMcpConfig` with `projectTrusted: false` (design §2): that flag only controls whether
 * `loadMcpConfig` itself additionally reads `<cwd>/.pi/mcp.json`, which Epi never wants, so it is
 * always false, and the two files Epi does want are read by varying `agentDir` instead. The second
 * call's entries are relabeled `scope: "project"` (Pi's own `loadMcpConfig` calls them "global"
 * because, from its point of view, `<project>/.epi` was just another `agentDir`); on a name clash
 * the project entry wins, matching Pi's own project-overrides-global rule.
 */
export function loadNativeMcpConfig(source, cwd) {
    const assembly = source.resolveAssembly();
    const global = piLoadMcpConfig({ agentDir: source.epiHome, cwd, projectTrusted: false });
    if (assembly.projectManifest?.loaded !== true) {
        return global;
    }
    const projectAgentDir = join(assembly.projectManifest.root, ".epi");
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
/** Shared by `/mcp` and `epi mcp list` (src/commands/mcp-cli.ts): what to run, in one sentence. `-l`
 * writes `<cwd>/.epi/mcp.json`, so it's offered only where `cwd` has a project Manifest (dogfood D47). */
export function emptyStateMessage(epiHome, cwd) {
    const local = existsSync(join(cwd, ".epi", "epi.json")) ? ", or with -l to this project's .epi/mcp.json" : "";
    return (`No MCP servers configured -- add one to ${join(epiHome, "mcp.json")} with ` +
        `\`epi mcp add <server> (--url <url> | -- <command> [args...])\`${local}.`);
}
/** The first line of Pi's `reportProblems()` notify (`extensions/mcp/index.js`), whose next lines are
 * `  <server>: <state>`, one per failed or needs-sign-in server, then `Run /mcp to fix.`. Epi's own
 * report at session_shutdown uses the same header and lines, so a run shows one kind of message
 * either way, but ends in `cliHint()` instead: `/mcp` does not exist outside the TUI. */
const ATTENTION_HEADER = "MCP servers need attention:";
/** Start of Pi's warning that MCP tools cannot be called because neither codemode nor tool_search is
 * active (`ensureDiscoveryActive`): about tool reachability -- e.g. `-p --no-tools`, which asked for
 * exactly that -- not a server that failed, so it is not copied to stderr (docs/mcp-design.md §7). */
const PI_UNREACHABLE_PREFIX = "MCP tools are only reachable from the codemode or tool_search tool";
/**
 * Pi's default `startupWaitMs` (createMcpExtension), passed explicitly because the session_shutdown
 * report uses the same bound: a server still connecting is named only once the session lasted longer
 * than this. Test seam: EPI_TEST_MCP_STARTUP_WAIT_MS shortens both.
 */
function mcpStartupWaitMs() {
    const override = Number(process.env.EPI_TEST_MCP_STARTUP_WAIT_MS);
    return Number.isFinite(override) && override > 0 ? override : 10_000;
}
/** What to run instead of `/mcp`, which outside the TUI does not exist: epi's own CLI (hard rule 4).
 * Names the server when exactly one needs a sign-in. */
function cliHint(lines) {
    const signIn = lines.flatMap((line) => {
        const match = /^ {2}(.+?): needs sign-in/.exec(line);
        return match ? [match[1]] : [];
    });
    const login = signIn.length === 0 ? "" : `, or "epi mcp login ${signIn.length === 1 ? signIn[0] : "<server>"}" to sign in`;
    return `From the shell: run "epi mcp list" to see why${login}.`;
}
/**
 * `  <server>: <state>` for every enabled server that failed or needs a sign-in, read from Pi's own
 * per-server state without waiting for anything. The state comes from the "/mcp" command's own
 * completions for `reconnect ` (`extensions/mcp/index.js`): one item per server that has a
 * connection, labelled with its name and described by Pi's private `describeState()` -- the same
 * text Pi's `reportProblems()` puts after the name (`failed: <first error line>`, `needs sign-in`;
 * `connected · N tools` and `disabled` are not problems). `connecting…` becomes
 * `  <server>: still connecting` with `includeConnecting` only. A server without a connection yet has
 * not been tried, so it is not a problem either.
 */
async function mcpProblemLines(completions, { includeConnecting }) {
    return ((await completions("reconnect ")) ?? []).flatMap((item) => {
        const state = item.description ?? "";
        if (state.startsWith("failed") || state.startsWith("needs sign-in"))
            return [`  ${item.label}: ${state}`];
        return includeConnecting && state.startsWith("connecting") ? [`  ${item.label}: still connecting`] : [];
    });
}
/**
 * `epi:mcp`: `createMcpExtension` (connections, OAuth, tool registration, `/mcp`) wired to Epi's own
 * config source, plus three Epi-only behaviors (a second "/mcp" from another extension is refused
 * at startup like any duplicate command, src/tui/services.ts):
 *   - `/mcp` with zero configured servers shows Epi's own message instead of Pi's (which names
 *     `.pi/mcp.json`, a path Epi never reads) -- done by wrapping the `pi` passed into Pi's factory
 *     so only the "mcp" registration is intercepted; every other call passes through untouched.
 *   - a server still connecting when the session shuts down is closed instead of holding the
 *     process open until its request timeout (dogfood D3, `trackingTransportFactory`).
 *   - outside the TUI, Pi's own MCP notifies reach stderr when there is no UI, and a failed or
 *     needs-sign-in server Pi had not reported by the end of the session is reported then
 *     (hard rule 3; docs/mcp-design.md §7).
 *
 * `credentials` is intentionally left to Pi's default rather than passed explicitly: its type is
 * `McpOAuthCredentialStore` (a class instance with a private `AuthStorageBackend`, not a path --
 * verified in `extensions/mcp/oauth.d.ts`), and constructing one only to point it at the same
 * location Pi already defaults to would import `oauth.js` for no isolation benefit. Pi's default
 * resolves through `getAgentDir()`, which Epi already redirects globally (`src/host.ts` sets
 * `PI_CODING_AGENT_DIR` to Epi's own `<epiHome>/pi` before Pi ever runs), so the default already
 * lands at `<epiHome>/pi/mcp-auth.json` -- test/mcp.test.mjs asserts this. `logPath` has no such
 * default-already-correct shortcut concern (it is a plain string), so it is passed explicitly for
 * auditability, matching the design.
 */
export function createEpiMcpExtension(source) {
    const { epiHome } = source;
    const loadConfig = (ctx) => loadNativeMcpConfig(source, ctx.cwd);
    const logPath = join(epiHome, "pi", "mcp.log");
    const transports = trackingTransportFactory();
    const startupWaitMs = mcpStartupWaitMs();
    const piFactory = createMcpExtension({ loadConfig, logPath, createTransport: transports.createTransport, startupWaitMs });
    return {
        name: "epi:mcp",
        factory: async (pi) => {
            // F3 (Fable milestone review, hard rule 3): captured so the session_shutdown report below can
            // read each server's state.
            let piMcpCompletions;
            // Hard rule 3 outside the TUI. Pi reports MCP problems only through ctx.ui.notify from its
            // event handlers -- "MCP failed to load: ..." (dogfood D6), "MCP servers need attention: ..."
            // (reportProblems(): failed and needs-sign-in servers, F3) and "MCP servers are still
            // connecting; ..." (the first prompt's wait for servers with direct tools ran out) -- and
            // ctx.ui.notify is a no-op in print/json mode (modes/print-mode.js's bindExtensions passes no
            // uiContext). So every handler Pi's MCP extension registers gets a ctx whose ui.notify also
            // writes the message, as is, to stderr when there is no UI (once per message and session);
            // after Pi's "Run /mcp to fix." block, one Epi line says what to run in the shell instead.
            // The unreachable-tools warning is not copied (PI_UNREACHABLE_PREFIX). The TUI shows them
            // itself, and rpc sends them to its client as extension_ui_request (D47, D52), so neither
            // gets a copy. Messages are Pi's own, so -p tells the same story as the TUI; stdout is never
            // touched.
            const writtenToStderr = new Set();
            // Every `  <server>: <state>` line Pi's reportProblems() has notified this session, in any
            // mode, so the session_shutdown report below adds only what Pi has not said.
            const piAttentionLines = new Set();
            // When the session started: the session_shutdown report names servers still connecting only
            // once it ran longer than startupWaitMs.
            let sessionStartedAt = Date.now();
            const bindTo = (owner, value) => typeof value === "function" ? value.bind(owner) : value;
            const reportingContext = (ctx) => new Proxy(ctx, {
                get(target, prop) {
                    if (prop !== "ui")
                        return bindTo(target, Reflect.get(target, prop, target));
                    const ui = target.ui;
                    return new Proxy(ui, {
                        get(uiTarget, uiProp) {
                            if (uiProp !== "notify")
                                return bindTo(uiTarget, Reflect.get(uiTarget, uiProp, uiTarget));
                            return (message, type) => {
                                const attentionLines = message.startsWith(ATTENTION_HEADER) ? message.split("\n").slice(1) : [];
                                for (const line of attentionLines)
                                    piAttentionLines.add(line);
                                if (!target.hasUI &&
                                    target.mode !== "tui" &&
                                    !message.startsWith(PI_UNREACHABLE_PREFIX) &&
                                    !writtenToStderr.has(message)) {
                                    writtenToStderr.add(message);
                                    const hint = attentionLines.length > 0 ? `\n${cliHint(attentionLines)}` : "";
                                    process.stderr.write(`${message}${hint}\n`);
                                }
                                return uiTarget.notify(message, type);
                            };
                        },
                    });
                },
            });
            // Registered before piFactory so the reset runs before Pi's own session_start starts connecting.
            pi.on("session_start", () => {
                writtenToStderr.clear();
                piAttentionLines.clear();
                sessionStartedAt = Date.now();
            });
            // Since Pi 0.99.2 only servers with direct tools hold up the first prompt; the others connect
            // in the background, and Pi's reportProblems() runs once *every* startup connection settled
            // (extensions/mcp/index.js's session_start). A -p run can end before that -- one hung server
            // holds the report back for its whole request timeout -- and Pi's session_shutdown then drops
            // it, so a server that had already failed was never reported. Registered before piFactory, so
            // it runs before Pi's own session_shutdown handler forgets the servers: outside the TUI (which
            // shows /mcp, and keeps running), each failed or needs-sign-in server Pi has not reported yet
            // is reported now, in Pi's own shape -- on stderr without a UI, to the rpc client with one --
            // ending in what to run in the shell rather than Pi's "/mcp". A server still connecting is
            // named too, but only once the session ran longer than startupWaitMs (which also covers Pi's
            // own still-connecting notify: its wait starts after session_start): since 0.99.2 a server
            // whose tools are not declared to the model connects in the background, so in a short run
            // still connecting is normal (dogfood D40; docs/mcp-design.md §7).
            pi.on("session_shutdown", async (_event, ctx) => {
                if (ctx.mode === "tui" || piMcpCompletions === undefined)
                    return;
                const includeConnecting = Date.now() - sessionStartedAt > startupWaitMs;
                const lines = (await mcpProblemLines(piMcpCompletions, { includeConnecting })).filter((line) => !piAttentionLines.has(line));
                if (lines.length === 0)
                    return;
                const message = `${ATTENTION_HEADER}\n${lines.join("\n")}\n${cliHint(lines)}`;
                if (ctx.hasUI) {
                    ctx.ui.notify(message, "warning");
                }
                else {
                    process.stderr.write(`${message}\n`);
                }
            });
            const wrappedPi = new Proxy(pi, {
                get(target, prop, _receiver) {
                    if (prop === "on") {
                        return (event, handler) => target.on(event, (piEvent, ctx) => handler(piEvent, reportingContext(ctx)));
                    }
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
                                        // API (pi.getMcpServers()); Epi's message is only for a project with truly
                                        // nothing to show.
                                        const configuredCount = loadConfig(ctx).servers.length;
                                        const registeredCount = pi.getMcpServers().length;
                                        if (configuredCount === 0 && registeredCount === 0) {
                                            ctx.ui.notify(emptyStateMessage(epiHome, ctx.cwd), "info");
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
        },
    };
}
//# sourceMappingURL=mcp.js.map