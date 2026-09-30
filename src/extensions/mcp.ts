import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type LoadedMcpConfig,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import type { ResolvedAssembly } from "../assembly.js";

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

interface McpConfigModule {
  loadMcpConfig(options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
  }): LoadedMcpConfig;
}

const { loadMcpConfig: piLoadMcpConfig } = (await import(
  pathToFileURL(join(piDist, "extensions", "mcp", "config.js")).href
)) as McpConfigModule;

export interface McpConfigSource {
  /** MMP's own home (`~/.mmp` or `$MMP_HOME`), never Pi's `<agentDir>/pi`. */
  mmpHome: string;
  /** Only `projectManifest` is ever read (never the rest of `ResolvedAssembly`), so `mmp mcp`
   * (src/commands/mcp-cli.ts) can build one without the full session assembly. Called fresh on
   * every invocation (session_start, /reload, /trust) -- never a captured value, so a project that
   * becomes trusted mid-run, or a Manifest reload, is picked up (docs/mcp-design.md §2 "如何复用 Pi
   * 的解析"). */
  resolveAssembly: () => Pick<ResolvedAssembly, "projectManifest">;
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
export function loadNativeMcpConfig(source: McpConfigSource, cwd: string): LoadedMcpConfig {
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

function emptyStateMessage(mmpHome: string): string {
  return (
    `No MCP servers configured. Add them to ${join(mmpHome, "mcp.json")} ` +
    `or .mmp/mcp.json in a trusted project, then run \`mmp mcp add\`.`
  );
}

const DUPLICATE_MCP_COMMAND_MESSAGE =
  "Another extension in the Manifest also registers \"/mcp\" alongside mmp:mcp. Pi's builtin-" +
  "replace mechanism does not apply to MMP's inline extensions, so both would silently rename to " +
  "\"/mcp:1\"/\"/mcp:2\" -- declare only one MCP integration in the Manifest.";

/** `pi.getCommands()` returns each command's final, post-collision invocation name (private
 * disambiguation in Pi's `ExtensionRunner.resolveRegisteredCommands`): when two extensions both
 * register "mcp", Pi renames *both* to "mcp:1"/"mcp:2" rather than keeping one plain "mcp" --
 * verified in `core/extensions/runner.js`. That is MMP's signal to fail visibly (docs/mcp-design.md
 * §4): a Manifest that declares another extension registering "/mcp" alongside "mmp:mcp". */
function hasDuplicateMcpCommand(pi: ExtensionAPI): boolean {
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
export function createMmpMcpExtension(source: McpConfigSource): InlineExtension {
  const { mmpHome, resolveAssembly } = source;
  const loadConfig = (ctx: ExtensionContext) => loadNativeMcpConfig(source, ctx.cwd);
  const logPath = join(mmpHome, "pi", "mcp.log");
  const piFactory = createMcpExtension({ loadConfig, logPath });

  return {
    name: "mmp:mcp",
    factory: async (pi: ExtensionAPI) => {
      const wrappedPi = new Proxy(pi, {
        get(target, prop, _receiver) {
          if (prop === "registerCommand") {
            return (
              name: string,
              commandOptions: Omit<RegisteredCommand, "name" | "sourceInfo">,
            ) => {
              if (name !== "mcp") {
                return target.registerCommand(name, commandOptions);
              }
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
      await piFactory(wrappedPi as ExtensionAPI);

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
    },
  };
}
