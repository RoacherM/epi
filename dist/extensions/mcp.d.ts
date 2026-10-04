import { type InlineExtension, type LoadedMcpConfig } from "@earendil-works/pi-coding-agent";
import type { ResolvedAssembly } from "../assembly.js";
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
export declare function loadNativeMcpConfig(source: McpConfigSource, cwd: string): LoadedMcpConfig;
/** Shared by `/mcp` and `mmp mcp list` (src/commands/mcp-cli.ts): what to run, in one sentence. `-l`
 * writes `<cwd>/.mmp/mcp.json`, so it's offered only where `cwd` has a project Manifest (dogfood D47). */
export declare function emptyStateMessage(mmpHome: string, cwd: string): string;
/**
 * `mmp:mcp`: `createMcpExtension` (connections, OAuth, tool registration, `/mcp`) wired to MMP's own
 * config source, plus three MMP-only behaviors (a second "/mcp" from another extension is refused
 * at startup like any duplicate command, src/tui/services.ts):
 *   - `/mcp` with zero configured servers shows MMP's own message instead of Pi's (which names
 *     `.pi/mcp.json`, a path MMP never reads) -- done by wrapping the `pi` passed into Pi's factory
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
 * resolves through `getAgentDir()`, which MMP already redirects globally (`src/host.ts` sets
 * `PI_CODING_AGENT_DIR` to MMP's own `<mmpHome>/pi` before Pi ever runs), so the default already
 * lands at `<mmpHome>/pi/mcp-auth.json` -- test/mcp.test.mjs asserts this. `logPath` has no such
 * default-already-correct shortcut concern (it is a plain string), so it is passed explicitly for
 * auditability, matching the design.
 */
export declare function createMmpMcpExtension(source: McpConfigSource): InlineExtension;
//# sourceMappingURL=mcp.d.ts.map