import { EpiConfigError } from "./errors.js";
import { resolveEpiPaths } from "./paths.js";

/**
 * Pi's own `PI_*` environment variables, isolated from the user's Pi environment (dogfood D63,
 * docs/cli-design.md §2.1). A value a user set for their Pi install must never change epi (no shared
 * config, docs/dev-workflow.md §5): every `PI_*` name Pi reads is cleared at startup, and the
 * user-facing ones are re-set from Epi's own `EPI_*` name.
 *
 * The table covers every `PI_*` name Pi's runtime code mentions; test/pi-internals.test.mjs
 * (`pi-env-reads`) fails when a Pi upgrade adds or drops one, so a new knob gets classified here
 * instead of leaking through.
 */
export type PiEnvRule =
  /** User-facing knob: Pi's variable is set from Epi's own name, same value and semantics. */
  | { kind: "bridged"; epi: string }
  /** Epi sets the variable itself later (agent dir, version-check opt-out). */
  | { kind: "epi-owned" }
  /** Not reachable in epi, or a Pi debug switch: only cleared, no Epi name. */
  | { kind: "cleared" };

export const PI_ENV_RULES: Readonly<Record<string, PiEnvRule>> = {
  PI_OFFLINE: { kind: "bridged", epi: "EPI_OFFLINE" },
  PI_CODING_AGENT_SESSION_DIR: { kind: "bridged", epi: "EPI_SESSION_DIR" },
  PI_TELEMETRY: { kind: "bridged", epi: "EPI_TELEMETRY" },
  PI_CACHE_RETENTION: { kind: "bridged", epi: "EPI_CACHE_RETENTION" },
  PI_OAUTH_CALLBACK_HOST: { kind: "bridged", epi: "EPI_OAUTH_CALLBACK_HOST" },
  PI_HYPERLINKS: { kind: "bridged", epi: "EPI_HYPERLINKS" },
  PI_IMAGE_PROTOCOL: { kind: "bridged", epi: "EPI_IMAGE_PROTOCOL" },
  PI_TRUE_COLOR: { kind: "bridged", epi: "EPI_TRUE_COLOR" },
  PI_TUI_ESC_TIMEOUT: { kind: "bridged", epi: "EPI_TUI_ESC_TIMEOUT" },
  PI_CODING_AGENT_DIR: { kind: "epi-owned" },
  PI_SKIP_VERSION_CHECK: { kind: "epi-owned" },
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
export const PI_ENV_NOT_READ: readonly string[] = [
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
 * Clears every `PI_*` variable in PI_ENV_RULES, then copies each bridged `EPI_*` variable that is
 * set (even to "") onto Pi's name, so Pi applies its own semantics to Epi's value. Must run before
 * any Pi module is evaluated: some read their variable at import time (`PI_PACKAGE_DIR` in
 * config.js, `PI_TIMING` in timings.js, `PI_OAUTH_CALLBACK_HOST` in two OAuth flows). Child
 * processes spawned with `process.env` (task workers, hooks, tools) inherit the result.
 *
 * `PI_CODING_AGENT_DIR` is set to Epi's own agent dir here too, not only later before each run:
 * Pi's utils/tools-manager.js fixes its managed fd/rg directory (`getBinDir()`) at import time, so
 * without this it would be `~/.pi/agent/bin`. An invalid EPI_HOME leaves it unset; the run then
 * fails on that error before any tool runs, while --help/--version still work.
 */
export function isolatePiEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(PI_ENV_RULES)) {
    delete env[name];
  }
  for (const [name, rule] of Object.entries(PI_ENV_RULES)) {
    if (rule.kind === "bridged" && env[rule.epi] !== undefined) {
      env[name] = env[rule.epi];
    }
  }
  let agentDir: string | undefined;
  try {
    agentDir = resolveEpiPaths(env).agentDir;
  } catch (error) {
    if (!(error instanceof EpiConfigError)) throw error;
  }
  if (agentDir !== undefined) env.PI_CODING_AGENT_DIR = agentDir;
}
