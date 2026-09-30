// Whether this run would land in Pi's interactive mode, shared by the project-trust prompt
// (src/trust-prompt.ts) and MMP's own TUI v2 gate (src/tui/start.ts). Kept dependency-free (only
// Pi's parseArgs) so host.ts can import it without loading the rest of the TUI.
import { parseArgs } from "@earendil-works/pi-coding-agent";
// MMP's own `auth`/`config`/`install`/`remove`/`uninstall`/`update`/`list` subcommands
// (docs/cli-design.md §3) are routed by host.ts's `runMmp` before argv ever reaches this function,
// so `piArgs` here never starts with one of them -- no carve-out needed.
/**
 * Pi's resolveAppMode (main.js): whether this run's `piArgs` would start Pi's interactive mode.
 * `--mode rpc`/`--mode json` win, then `-p` or a non-TTY stdin/stdout is print; anything else --
 * no `--mode` or `--mode text` -- is interactive (dogfood D53: `--mode text` on a terminal used to
 * reach Pi's own InteractiveMode through piMain). `--help`, `--list-models` and `--export` are
 * handled before Pi picks a mode, so they never are. test/interactive.test.mjs checks this against
 * Pi's own resolveAppMode (docs/pi-internals.md `resolve-app-mode`).
 */
export function isInteractivePiRun(piArgs, stdinIsTTY, stdoutIsTTY) {
    if (!stdinIsTTY || !stdoutIsTTY)
        return false;
    const parsed = parseArgs([...piArgs]);
    if (parsed.mode === "rpc" || parsed.mode === "json" || parsed.print)
        return false;
    return !parsed.help && parsed.listModels === undefined && parsed.export === undefined;
}
//# sourceMappingURL=interactive.js.map