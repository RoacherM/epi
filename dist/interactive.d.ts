/**
 * Pi's resolveAppMode (main.js): whether this run's `piArgs` would start Pi's interactive mode.
 * `--mode rpc`/`--mode json` win, then `-p` or a non-TTY stdin/stdout is print; anything else --
 * no `--mode` or `--mode text` -- is interactive (dogfood D53: `--mode text` on a terminal used to
 * reach Pi's own InteractiveMode through Pi's main()). `--help`, `--list-models` and `--export` are
 * handled before Pi picks a mode, so they never are. test/interactive.test.mjs checks this against
 * Pi's own resolveAppMode (docs/pi-internals.md `resolve-app-mode`).
 */
export declare function isInteractivePiRun(piArgs: readonly string[], stdinIsTTY: boolean, stdoutIsTTY: boolean): boolean;
//# sourceMappingURL=interactive.d.ts.map