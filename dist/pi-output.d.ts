/**
 * Pi's `main.js` ends a startup extension load failure with this hint (its unexported
 * `EXTENSION_LOAD_FAILURE_HINT`, with `APP_NAME` = "pi"). MMP has no `-ne` and exposes only its own
 * options (hard rule 4), so the line is swapped for MMP's own (docs/pi-internals.md,
 * `pi-extension-load-hint`). Every other `pi`-naming text Pi can print is out of MMP's reach: MMP
 * handles `--help`, `auth`, `mcp` and the other subcommands itself, never loads Pi's built-in
 * extensions, and doesn't run Pi's interactive mode.
 */
export declare const PI_EXTENSION_LOAD_FAILURE_HINT = "Hint: Start without extensions using \"pi -ne\".";
export declare const EXTENSION_LOAD_FAILURE_HINT = "Hint: Fix the extension, or remove it from the Manifest that declares it (\"mmp list\" shows which).";
/**
 * For the piMain path, where Pi itself writes the hint with `console.error` right before
 * `process.exit(1)`: there is nothing to catch, so the rewrite happens on stderr. Only that exact
 * text is replaced; the error lines before it pass through unchanged.
 */
export declare function rewritePiStderr(): void;
//# sourceMappingURL=pi-output.d.ts.map