// Whether this run would land in Pi's interactive mode, shared by the project-trust prompt
// (src/trust-prompt.ts) and MMP's own TUI v2 gate (src/tui/start.ts). Kept dependency-free (only
// Pi's parseArgs) so host.ts can import it without loading the rest of the TUI.
import { parseArgs } from "@earendil-works/pi-coding-agent";

// Pi's main.js (runAuthCommand, handleConfigCommand, handlePackageCommand) matches these exactly
// as the first CLI token, before any interactive/print mode resolution, and exits without ever
// reaching interactive mode. MMP forwards them unchanged, so they must not trigger a prompt.
const PI_CLI_SUBCOMMANDS = new Set([
  "auth",
  "config",
  "install",
  "remove",
  "uninstall",
  "update",
  "list",
]);

/** Pi's resolveAppMode, plus the CLI subcommands Pi's dispatcher handles before that. */
export function isInteractivePiRun(
  piArgs: readonly string[],
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  if (!stdinIsTTY || !stdoutIsTTY) return false;
  if (piArgs.length > 0 && PI_CLI_SUBCOMMANDS.has(piArgs[0]!)) return false;
  const parsed = parseArgs([...piArgs]);
  return parsed.mode === undefined && !parsed.print && !parsed.help &&
    parsed.listModels === undefined && parsed.export === undefined;
}
