// Whether this run would land in Pi's interactive mode, shared by the project-trust prompt
// (src/trust-prompt.ts) and MMP's own TUI v2 gate (src/tui/start.ts). Kept dependency-free (only
// Pi's parseArgs) so host.ts can import it without loading the rest of the TUI.
import { parseArgs } from "@earendil-works/pi-coding-agent";
// MMP's own `auth`/`config`/`install`/`remove`/`uninstall`/`update`/`list` subcommands
// (docs/cli-design.md §3) are routed by host.ts's `runMmp` before argv ever reaches this function,
// so `piArgs` here never starts with one of them -- no carve-out needed.
/** Pi's resolveAppMode: whether this run's `piArgs` would start Pi's interactive mode. */
export function isInteractivePiRun(piArgs, stdinIsTTY, stdoutIsTTY) {
    if (!stdinIsTTY || !stdoutIsTTY)
        return false;
    const parsed = parseArgs([...piArgs]);
    return parsed.mode === undefined && !parsed.print && !parsed.help &&
        parsed.listModels === undefined && parsed.export === undefined;
}
//# sourceMappingURL=interactive.js.map