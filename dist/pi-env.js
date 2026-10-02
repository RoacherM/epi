import { MmpConfigError } from "./errors.js";
import { resolveMmpPaths } from "./paths.js";
export const PI_ENV_RULES = {
    PI_OFFLINE: { kind: "bridged", mmp: "MMP_OFFLINE" },
    PI_CODING_AGENT_SESSION_DIR: { kind: "bridged", mmp: "MMP_SESSION_DIR" },
    PI_TELEMETRY: { kind: "bridged", mmp: "MMP_TELEMETRY" },
    PI_CACHE_RETENTION: { kind: "bridged", mmp: "MMP_CACHE_RETENTION" },
    PI_OAUTH_CALLBACK_HOST: { kind: "bridged", mmp: "MMP_OAUTH_CALLBACK_HOST" },
    PI_HYPERLINKS: { kind: "bridged", mmp: "MMP_HYPERLINKS" },
    PI_IMAGE_PROTOCOL: { kind: "bridged", mmp: "MMP_IMAGE_PROTOCOL" },
    PI_TRUE_COLOR: { kind: "bridged", mmp: "MMP_TRUE_COLOR" },
    PI_TUI_ESC_TIMEOUT: { kind: "bridged", mmp: "MMP_TUI_ESC_TIMEOUT" },
    PI_CODING_AGENT_DIR: { kind: "mmp-owned" },
    PI_SKIP_VERSION_CHECK: { kind: "mmp-owned" },
    PI_PACKAGE_DIR: { kind: "cleared" },
    PI_SHARE_VIEWER_URL: { kind: "cleared" },
    PI_RADIUS_GATEWAY: { kind: "cleared" },
    PI_HARDWARE_CURSOR: { kind: "cleared" },
    PI_CLEAR_ON_SHRINK: { kind: "cleared" },
    PI_EXPERIMENTAL: { kind: "cleared" },
    PI_STARTUP_BENCHMARK: { kind: "cleared" },
    PI_TIMING: { kind: "cleared" },
    PI_TUI_DEBUG: { kind: "cleared" },
    PI_TUI_DEBUG_REDRAW: { kind: "cleared" },
    PI_TUI_WRITE_LOG: { kind: "cleared" },
    PI_MANAGED_INSTALL_ROOT: { kind: "cleared" },
    PI_INSTALLER_API_BASE: { kind: "cleared" },
};
/**
 * `PI_*` names that appear in Pi's code but are not inputs Pi reads: Pi writes them for child
 * processes, or the name is not an environment variable at all. Listed so the pin test can tell
 * them apart from an unclassified read.
 */
export const PI_ENV_NOT_READ = [
    // Process marker Pi's CLI/RPC entry sets for children (docs/environment-variables.md).
    "PI_CODING_AGENT",
    // Set by the bash tool for the commands it runs; it deletes inherited values itself.
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
    // A build-time global of Pi's compiled binary (`typeof PI_BUNDLED_NODE`), not process.env.
    "PI_BUNDLED_NODE",
];
/**
 * Clears every `PI_*` variable in PI_ENV_RULES, then copies each bridged `MMP_*` variable that is
 * set (even to "") onto Pi's name, so Pi applies its own semantics to MMP's value. Must run before
 * any Pi module is evaluated: some read their variable at import time (`PI_PACKAGE_DIR` in
 * config.js, `PI_TIMING` in timings.js, `PI_OAUTH_CALLBACK_HOST` in two OAuth flows). Child
 * processes spawned with `process.env` (task workers, hooks, tools) inherit the result.
 *
 * `PI_CODING_AGENT_DIR` is set to MMP's own agent dir here too, not only later before each run:
 * Pi's utils/tools-manager.js fixes its managed fd/rg directory (`getBinDir()`) at import time, so
 * without this it would be `~/.pi/agent/bin`. An invalid MMP_HOME leaves it unset; the run then
 * fails on that error before any tool runs, while --help/--version still work.
 */
export function isolatePiEnvironment(env) {
    for (const name of Object.keys(PI_ENV_RULES)) {
        delete env[name];
    }
    for (const [name, rule] of Object.entries(PI_ENV_RULES)) {
        if (rule.kind === "bridged" && env[rule.mmp] !== undefined) {
            env[name] = env[rule.mmp];
        }
    }
    let agentDir;
    try {
        agentDir = resolveMmpPaths(env).agentDir;
    }
    catch (error) {
        if (!(error instanceof MmpConfigError))
            throw error;
    }
    if (agentDir !== undefined)
        env.PI_CODING_AGENT_DIR = agentDir;
}
//# sourceMappingURL=pi-env.js.map