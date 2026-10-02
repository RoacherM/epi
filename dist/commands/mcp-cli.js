// `mmp mcp add|remove|list|login|logout` (docs/mcp-design.md §6): usage aligned to Pi's own
// `pi mcp` (extensions/mcp/cli.js), but MMP parses its own arguments and reads/writes its own
// files -- Pi's `runMcpCommand` can't be reused directly: its project config path is hardcoded to
// `join(cwd, CONFIG_DIR_NAME, "mcp.json")` (`.pi/mcp.json`, cli.js:127) and its trust check uses
// Pi's own `ProjectTrustStore` (cli.js:133), never MMP's Manifest-based trust. What MMP does reuse:
// config.js's add/remove/load/getMcpToolExposure and runtime.js's connection/OAuth pieces (both
// registered in docs/pi-internals.md, extending the same "mcp-native-config-loader" row and a new
// "mcp-native-runtime" row) -- so the file format, validation, and connection behavior stay
// identical to Pi's and upgrade automatically.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MmpArgumentError } from "../errors.js";
import { assertProjectTrustedFor, isHelpRequested } from "./manifest-cli.js";
import { emptyStateMessage, loadNativeMcpConfig } from "../extensions/mcp.js";
import { resolveMmpPaths } from "../paths.js";
import { findNearestProjectManifest, readProjectTrustDecision } from "../project.js";
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { addMcpServerConfig, removeMcpServerConfig, getMcpToolExposure } = (await import(pathToFileURL(join(piDist, "extensions", "mcp", "config.js")).href));
const { validateMcpServerConfig } = (await import(pathToFileURL(join(piDist, "core", "mcp-servers.js")).href));
const HELP = `Usage:
  mmp mcp add <server> [options] (--url <url> | -- <command> [args...])
  mmp mcp remove <server> [-l]
  mmp mcp list [--json] [--approve|--no-approve]
  mmp mcp login <server> [--timeout <seconds>] [--approve|--no-approve]
  mmp mcp logout <server> [--approve|--no-approve]

Configure and check MCP servers, and sign in to OAuth servers, without starting a session.
Reads ~/.mmp/mcp.json and, in a trusted project, .mmp/mcp.json.

Commands:
  add <server>            Add or replace a server in mcp.json
  remove <server>         Remove a server from mcp.json
  list                    Show state, tools, and errors (exits 1 on failure)
  login <server>          Sign in through the browser
  logout <server>         Delete the stored OAuth credentials

Options for add and remove:
  -l, --local             Use .mmp/mcp.json in the current project instead of the global file

Trust (every command):
  -a, --approve           Trust the project Manifest for this run, even if the project isn't
                          otherwise trusted: add/remove -l may write the project's .mmp/mcp.json,
                          list/login/logout read it. Does not persist -- /trust in mmp does
  -na, --no-approve       Treat the project as untrusted for this run, even if it is trusted

Options for add:
  --url <url>             Streamable HTTP server URL (instead of a command)
  --env <KEY=VALUE>       Environment variable for a stdio server (repeatable)
  --cwd <dir>             Working directory for a stdio server
  --header <KEY=VALUE>    HTTP header (repeatable)
  --bearer-token-env-var <NAME>
                          Send "Authorization: Bearer \${NAME}"
  --oauth-client-id <id>  Pre-registered OAuth client id
  --oauth-client-secret <secret>
                          OAuth client secret (may be \${NAME} or !command)
  --oauth-callback-port <port>
                          Fixed OAuth callback port
  --oauth-client-name <name>
                          Client name sent when registering with the OAuth server
  --exposure <mode>       codemode (default), deferred, direct, or hidden
  --description <text>    What the server offers, shown in the system prompt

Other options:
  --json                  Print the list as JSON
  --timeout <seconds>     How long login waits for the browser (default: 300)
`;
const HELP_HINT = 'Use "mmp mcp --help" for usage.';
const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function describeTransport(entry) {
    const { config } = entry;
    return "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}
const OPTION_ALIASES = new Map([["-l", "--local"], ["-a", "--approve"], ["-na", "--no-approve"]]);
const APPROVE_OPTIONS = { approve: "flag", "no-approve": "flag" };
/** `--approve`/`--no-approve` as a this-run-only override of the saved trust decision (decisions
 * U4, same as `mmp install -l`): true, false, or undefined for "use the saved decision". */
function approveOverrideOf(values) {
    if (values.has("approve") && values.has("no-approve")) {
        throw new MmpArgumentError(`--approve and --no-approve can't be used together.\n${HELP_HINT}`);
    }
    return values.has("approve") ? true : values.has("no-approve") ? false : undefined;
}
/** Parses `--name value` options; throws on an unknown one. `--` ends the options, as does
 * reaching `maxPositionals` positional arguments -- mirrors Pi's own `parseOptions` (cli.js, not
 * exported), so an added stdio command's own flags (`add <server> -- node script.js --flag`) pass
 * through untouched. */
function parseOptions(args, known, maxPositionals = Number.POSITIVE_INFINITY) {
    const positional = [];
    const values = new Map();
    const lists = new Map();
    for (let index = 0; index < args.length; index += 1) {
        const raw = args[index];
        const arg = OPTION_ALIASES.get(raw) ?? raw;
        if (arg === "--" || positional.length >= maxPositionals) {
            positional.push(...args.slice(arg === "--" ? index + 1 : index));
            break;
        }
        if (!arg.startsWith("--")) {
            positional.push(arg);
            continue;
        }
        const name = arg.slice(2);
        const kind = known[name];
        if (kind === undefined) {
            throw new MmpArgumentError(`Unknown option ${arg}.\n${HELP_HINT}`);
        }
        if (kind === "flag") {
            values.set(name, true);
            continue;
        }
        const value = args[index + 1];
        if (value === undefined) {
            throw new MmpArgumentError(`${arg} needs a value.`);
        }
        index += 1;
        if (kind === "list") {
            lists.set(name, [...(lists.get(name) ?? []), value]);
        }
        else {
            values.set(name, value);
        }
    }
    return { positional, values, lists };
}
function parsePairs(option, pairs) {
    const record = {};
    for (const pair of pairs ?? []) {
        const separator = pair.indexOf("=");
        if (separator <= 0) {
            throw new MmpArgumentError(`--${option} expects KEY=VALUE, got "${pair}".`);
        }
        record[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    return record;
}
function globalConfigPath(ctx) {
    return join(ctx.mmpHome, "mcp.json");
}
function localConfigPath(ctx) {
    return join(ctx.cwd, ".mmp", "mcp.json");
}
/** `-l` changes the `.mmp/mcp.json` right here (like `mmp install -l`), which only counts in a trusted
 * project. Where there is no project Manifest and nothing overrides the trust check, the refusal
 * says there's no project rather than that it isn't trusted (dogfood D47). */
function assertLocalAllowed(ctx, approveOverride) {
    if (approveOverride === undefined &&
        !existsSync(join(ctx.cwd, ".mmp", "mmp.json")) &&
        readProjectTrustDecision(resolveMmpPaths(process.env).agentDir, ctx.cwd) !== true) {
        throw new MmpArgumentError(`${ctx.cwd} has no .mmp/mmp.json, so it is not an MMP project -- -l has nothing to change here. ` +
            `Create the project with \`mmp config -l --approve\`, or leave out -l to use ${globalConfigPath(ctx)}.`);
    }
    assertProjectTrustedFor(ctx.cwd, approveOverride);
}
/** The merged view a real session would see: global always, project only when trusted -- built the
 * same way src/extensions/mcp.ts does, but walking up to the nearest project Manifest (like
 * `mmp list`) rather than "only exactly cwd" (like `add -l`/`remove -l`, which always write "here",
 * matching `mmp install -l`). `approveOverride` replaces the saved decision for this run only, like
 * `mmp --approve`/`--no-approve` (src/project.ts's resolveProjectManifest); nothing is persisted. */
function resolveListConfig(ctx, approveOverride, command) {
    const paths = resolveMmpPaths(process.env);
    const candidate = findNearestProjectManifest(ctx.cwd, paths.globalManifest);
    const trusted = candidate !== undefined && (approveOverride ?? readProjectTrustDecision(paths.agentDir, ctx.cwd) === true);
    const ignoredPath = candidate === undefined ? undefined : join(candidate.root, ".mmp", "mcp.json");
    const untrustedNote = candidate === undefined || trusted
        ? undefined
        : approveOverride === false
            ? `${ignoredPath} is ignored because of --no-approve.`
            : `${ignoredPath} is ignored because the project is not trusted. Add --approve to read it this once (mmp mcp ${command} --approve), or trust the project with /trust in mmp.`;
    const loaded = loadNativeMcpConfig({
        mmpHome: ctx.mmpHome,
        resolveAssembly: () => trusted && candidate !== undefined
            ? { projectManifest: { loaded: true, root: candidate.root, path: candidate.manifestPath, trusted: true } }
            : { projectManifest: undefined },
    }, ctx.cwd);
    return { loaded, untrustedNote };
}
const ADD_OPTIONS = {
    local: "flag",
    ...APPROVE_OPTIONS,
    url: "value",
    env: "list",
    cwd: "value",
    header: "list",
    "bearer-token-env-var": "value",
    "oauth-client-id": "value",
    "oauth-client-secret": "value",
    "oauth-callback-port": "value",
    "oauth-client-name": "value",
    exposure: "value",
    description: "value",
};
const HTTP_ONLY_OPTIONS = [
    "header",
    "bearer-token-env-var",
    "oauth-client-id",
    "oauth-client-secret",
    "oauth-callback-port",
    "oauth-client-name",
];
const STDIO_ONLY_OPTIONS = ["env", "cwd"];
function stringOption(values, option) {
    const found = values.get(option);
    return typeof found === "string" ? found : undefined;
}
function httpServerConfig(url, { values, lists }) {
    const value = (option) => stringOption(values, option);
    const headers = parsePairs("header", lists.get("header"));
    const bearer = value("bearer-token-env-var");
    if (bearer !== undefined)
        headers.Authorization = `Bearer \${${bearer}}`;
    const port = value("oauth-callback-port");
    const oauth = {
        ...(value("oauth-client-id") === undefined ? {} : { clientId: value("oauth-client-id") }),
        ...(value("oauth-client-secret") === undefined ? {} : { clientSecret: value("oauth-client-secret") }),
        ...(port === undefined ? {} : { callbackPort: Number(port) }),
        ...(value("oauth-client-name") === undefined ? {} : { clientName: value("oauth-client-name") }),
    };
    return {
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(oauth).length > 0 ? { oauth } : {}),
    };
}
function stdioServerConfig(command, { values, lists }) {
    const env = parsePairs("env", lists.get("env"));
    const cwd = stringOption(values, "cwd");
    const [executable, ...commandArgs] = command;
    return {
        command: executable,
        ...(commandArgs.length > 0 ? { args: commandArgs } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cwd === undefined ? {} : { cwd }),
    };
}
/** The flag checks and config object of Pi's `add` (cli.js), validated by Pi's own
 * validateMcpServerConfig; writes nothing. */
function buildServerConfig(parsed) {
    const { positional, values, lists } = parsed;
    const [name, ...command] = positional;
    const url = stringOption(values, "url");
    if (!name || (url === undefined) === (command.length === 0)) {
        throw new MmpArgumentError(`Usage: mmp mcp add <server> [options] (--url <url> | -- <command> [args...])\n${HELP_HINT}`);
    }
    const misplaced = (url === undefined ? HTTP_ONLY_OPTIONS : STDIO_ONLY_OPTIONS).find((option) => values.has(option) || lists.has(option));
    if (misplaced) {
        throw new MmpArgumentError(`--${misplaced} only applies to ${url === undefined ? "HTTP servers (--url)" : "stdio servers"}.`);
    }
    const config = url === undefined ? stdioServerConfig(command, parsed) : httpServerConfig(url, parsed);
    const exposure = stringOption(values, "exposure");
    if (exposure !== undefined)
        config.exposure = exposure;
    const description = stringOption(values, "description");
    if (description !== undefined)
        config.description = description;
    const validated = validateMcpServerConfig(name, config);
    if (typeof validated === "string") {
        throw new MmpArgumentError(validated);
    }
    return { name, config: validated };
}
/** What to run next, after the "Added/Replaced" line -- Pi's `add` ends with the same hints. */
function printAddFollowUp(ctx, path, local, name, config) {
    let approveHint = "";
    if (local) {
        // assertProjectTrustedFor only gates *this write* (an --approve override is this-run-only,
        // never persisted) -- without one of these two hints, a plain future `mmp` or `mmp mcp list`
        // would silently ignore the file just written, which is exactly the "failure must be visible"
        // violation Pi's own cli.js:294-296 hint (a different case: it always creates the project
        // Manifest first, so only the trust half applies there) also exists to prevent.
        if (!existsSync(join(ctx.cwd, ".mmp", "mmp.json"))) {
            console.log(`${ctx.cwd} has no .mmp/mmp.json yet, so it is not an MMP project -- ${path} is ignored until you run \`mmp install -l\` (or \`mmp config -l\`) here.`);
        }
        else if (readProjectTrustDecision(resolveMmpPaths(process.env).agentDir, ctx.cwd) !== true) {
            console.log(`The project is not trusted, so ${path} is ignored until you start mmp in the project and trust it (mmp --approve or /trust).`);
            // list and login read the file only with the same this-run override (dogfood D47).
            approveHint = " --approve";
        }
    }
    const mayNeedSignIn = "url" in config && !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
    console.log(`Check it with: mmp mcp list${approveHint}${mayNeedSignIn ? `. If it requires sign-in: mmp mcp login ${name}${approveHint}` : ""}`);
}
function addCommand(args, ctx) {
    const parsed = parseOptions(args, ADD_OPTIONS, 2);
    const approveOverride = approveOverrideOf(parsed.values);
    const { name, config } = buildServerConfig(parsed);
    const local = parsed.values.has("local");
    if (local) {
        assertLocalAllowed(ctx, approveOverride);
    }
    const path = local ? localConfigPath(ctx) : globalConfigPath(ctx);
    let replaced;
    try {
        replaced = addMcpServerConfig(path, name, config);
    }
    catch (addError) {
        throw new MmpArgumentError(`Could not update ${path}: ${errorMessage(addError)}`);
    }
    console.log(`${replaced ? "Replaced" : "Added"} ${local ? "project" : "global"} MCP server "${name}" in ${path}.`);
    printAddFollowUp(ctx, path, local, name, config);
    return 0;
}
function removeCommand(args, ctx) {
    const parsed = parseOptions(args, { local: "flag", ...APPROVE_OPTIONS });
    const [name, ...extra] = parsed.positional;
    if (!name || extra.length > 0) {
        throw new MmpArgumentError(`Usage: mmp mcp remove <server> [-l]\n${HELP_HINT}`);
    }
    const approveOverride = approveOverrideOf(parsed.values);
    const local = parsed.values.has("local");
    if (local) {
        assertLocalAllowed(ctx, approveOverride);
    }
    const path = local ? localConfigPath(ctx) : globalConfigPath(ctx);
    let removed;
    try {
        removed = removeMcpServerConfig(path, name);
    }
    catch (removeError) {
        throw new MmpArgumentError(`Could not update ${path}: ${errorMessage(removeError)}`);
    }
    if (removed) {
        console.log(`Removed ${local ? "project" : "global"} MCP server "${name}" from ${path}.`);
        return 0;
    }
    const scope = local ? "project" : "global";
    // Mirrors cli.js's remove: not found in the requested scope doesn't mean not configured at all --
    // check the other scope (within what MMP already trusts enough to read; unlike Pi's own CLI, this
    // never reads an untrusted project's mcp.json just for a nicer error) and name where it actually
    // lives, with MMP's own paths and flag (`-l`, not Pi's `--local`).
    const other = resolveListConfig(ctx, approveOverride, "remove").loaded.servers.find((server) => server.name === name && (server.scope ?? "global") !== scope);
    const otherHint = other === undefined ? "" : ` It is defined in ${other.source}${other.scope === "project" ? "; use -l" : "; omit -l"}.`;
    console.error(`No ${scope} MCP server named "${name}" in ${path}.${otherHint}`);
    return 1;
}
async function loadRuntimeModule() {
    // pi-internals row `mcp-native-runtime`: extensions/mcp/runtime.js. Imported lazily, only by the
    // list/login/logout branches below -- add/remove need only config.js/core/mcp-servers.js, and
    // runtime.js pulls in the (heavier) @earendil-works/pi-mcp client, mirroring Pi's own
    // runtime.lazy.js cost-avoidance for the exact same reason.
    return (await import(pathToFileURL(join(piDist, "extensions", "mcp", "runtime.js")).href));
}
async function listCommand(args, ctx) {
    const parsed = parseOptions(args, { json: "flag", ...APPROVE_OPTIONS });
    if (parsed.positional.length > 0) {
        throw new MmpArgumentError(`Usage: mmp mcp list [--json] [--approve|--no-approve]\n${HELP_HINT}`);
    }
    const json = parsed.values.has("json");
    const { loaded, untrustedNote } = resolveListConfig(ctx, approveOverrideOf(parsed.values), "list");
    const runtime = await loadRuntimeModule();
    const credentials = new runtime.McpOAuthCredentialStore();
    const reports = await Promise.all(loaded.servers.map(async (entry) => {
        const report = {
            name: entry.name,
            scope: entry.scope ?? "global",
            source: entry.source,
            enabled: entry.config.enabled !== false,
            exposure: entry.config.exposure ?? "codemode",
            transport: describeTransport(entry),
            state: "disabled",
            tools: [],
        };
        if (!report.enabled)
            return report;
        const connection = new runtime.McpServerConnection({
            entry,
            cwd: ctx.cwd,
            createTransport: runtime.createDefaultTransport,
            credentials,
            log: new runtime.McpServerLog(join(ctx.mmpHome, "pi", "mcp.log")),
            onTools: () => { },
        });
        try {
            await connection.getClient();
        }
        catch {
            // The connection records the state and error.
        }
        report.state = connection.state;
        report.tools = connection.tools.map((tool) => tool.name);
        const overrides = connection.tools.flatMap((tool) => {
            const exposure = getMcpToolExposure(entry.config, tool.name);
            return exposure === report.exposure ? [] : [[tool.name, exposure]];
        });
        if (overrides.length > 0)
            report.toolExposure = Object.fromEntries(overrides);
        if (connection.hasResources) {
            report.resources = connection.resources.length;
            report.resourceTemplates = connection.resourceTemplates.length;
        }
        if (connection.state !== "connected" && connection.error)
            report.error = connection.error;
        await connection.close();
        return report;
    }));
    const failed = loaded.errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");
    if (json) {
        console.log(JSON.stringify({ servers: reports, errors: loaded.errors, ...(untrustedNote ? { note: untrustedNote } : {}) }, null, 2));
        return failed ? 1 : 0;
    }
    if (reports.length === 0 && loaded.errors.length === 0) {
        console.log(emptyStateMessage(ctx.mmpHome, ctx.cwd));
    }
    for (const report of reports) {
        const state = report.state === "connected"
            ? `connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`
            : report.state === "needs-auth"
                ? "needs sign-in"
                : report.state;
        console.log(`${report.name}: ${state} (${report.exposure}, ${report.scope})`);
        console.log(`  ${report.transport}`);
        if (report.state === "needs-auth")
            console.log(`  sign in with: mmp mcp login ${report.name}`);
        if (report.tools.length > 0) {
            const tools = report.tools.map((tool) => {
                const exposure = report.toolExposure?.[tool];
                return exposure ? `${tool} [${exposure}]` : tool;
            });
            console.log(`  tools: ${tools.join(", ")}`);
        }
        if (report.resources !== undefined) {
            console.log(`  resources: ${report.resources}, URI templates: ${report.resourceTemplates ?? 0}`);
        }
        if (report.error)
            console.log(`  ${report.error.split("\n").join("\n  ")}`);
    }
    for (const configError of loaded.errors)
        console.log(`config error: ${configError}`);
    if (untrustedNote)
        console.log(untrustedNote);
    return failed ? 1 : 0;
}
async function loginOrLogoutCommand(command, args, ctx) {
    const parsed = parseOptions(args, command === "login" ? { timeout: "value", ...APPROVE_OPTIONS } : APPROVE_OPTIONS);
    const [name, ...extra] = parsed.positional;
    if (!name || extra.length > 0) {
        throw new MmpArgumentError(`Usage: mmp mcp ${command} <server> [--approve|--no-approve]\n${HELP_HINT}`);
    }
    const { loaded, untrustedNote } = resolveListConfig(ctx, approveOverrideOf(parsed.values), command);
    const entry = loaded.servers.find((server) => server.name === name);
    if (!entry) {
        console.error(`No MCP server named "${name}".${untrustedNote ? ` ${untrustedNote}` : ""} Configured: ${loaded.servers.map((server) => server.name).join(", ") || "none"}.`);
        return 1;
    }
    const runtime = await loadRuntimeModule();
    const credentials = new runtime.McpOAuthCredentialStore();
    const connection = new runtime.McpServerConnection({
        entry,
        cwd: ctx.cwd,
        createTransport: runtime.createDefaultTransport,
        credentials,
        log: new runtime.McpServerLog(join(ctx.mmpHome, "pi", "mcp.log")),
        onTools: () => { },
    });
    const url = connection.oauthUrl;
    if (!url) {
        await connection.close();
        console.error(`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`);
        return 1;
    }
    try {
        if (command === "logout") {
            const removed = credentials.remove(name, url);
            console.log(removed ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`);
            return 0;
        }
        const timeoutSeconds = Number(parsed.values.get("timeout") ?? DEFAULT_LOGIN_TIMEOUT_SECONDS);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
            console.error("--timeout must be a positive number of seconds.");
            return 1;
        }
        try {
            await connection.getClient();
            console.log(`Already signed in to MCP server "${name}" (${connection.tools.length} tools).`);
            return 0;
        }
        catch {
            if (connection.state !== "needs-auth") {
                console.error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
                return 1;
            }
        }
        try {
            await runtime.signInMcpServer({
                serverUrl: url,
                store: credentials.forServer(name, url),
                settings: connection.oauthSettings(),
                challenge: connection.challenge,
                prompt: {
                    showAuthorizationUrl: (authorizationUrl) => {
                        console.log(`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`);
                    },
                    // Non-interactive-friendly default: mmp mcp login is meant to be run by an agent through
                    // bash (module comment), so it never blocks on stdin -- it waits out the timeout instead.
                    promptForRedirectUrl: (signal) => new Promise((resolve) => {
                        signal.addEventListener("abort", () => resolve(undefined), { once: true });
                    }),
                },
            });
        }
        catch (signInError) {
            console.error(signInError instanceof runtime.McpSignInCancelledError
                ? `Sign-in to MCP server "${name}" was cancelled or not completed within ${timeoutSeconds} seconds.`
                : `Sign-in to MCP server "${name}" failed: ${errorMessage(signInError)}`);
            return 1;
        }
        connection.challenge = undefined;
        try {
            await connection.reconnect();
        }
        catch (connectError) {
            console.error(`Signed in, but ${errorMessage(connectError)}`);
            return 1;
        }
        console.log(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`);
        return 0;
    }
    finally {
        await connection.close();
    }
}
export async function runMcpCommand(argv) {
    if (isHelpRequested(argv) || argv.length === 0) {
        process.stdout.write(HELP);
        return 0;
    }
    const [command, ...rest] = argv;
    const ctx = { mmpHome: resolveMmpPaths(process.env).mmpHome, cwd: process.cwd() };
    switch (command) {
        case "add":
            return addCommand(rest, ctx);
        case "remove":
            return removeCommand(rest, ctx);
        case "list":
            return listCommand(rest, ctx);
        case "login":
            return loginOrLogoutCommand("login", rest, ctx);
        case "logout":
            return loginOrLogoutCommand("logout", rest, ctx);
        default:
            throw new MmpArgumentError(`Unknown mcp command "${command}".\n${HELP_HINT}`);
    }
}
//# sourceMappingURL=mcp-cli.js.map