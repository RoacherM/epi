import { type ResolvedAssembly } from "./assembly.js";
/**
 * Pi's `main.js` ends a startup extension load failure with this hint (its unexported
 * `EXTENSION_LOAD_FAILURE_HINT`, with `APP_NAME` = "pi"). MMP has no `-ne` and exposes only its own
 * options (hard rule 4), so the line is swapped for MMP's own (docs/pi-internals.md,
 * `pi-extension-load-hint`). Pi's login guidance is swapped the same way (`rewritePiText`). Every
 * other `pi`-naming text Pi can print is out of MMP's reach: MMP handles `--help`, `auth`, `mcp` and
 * the other subcommands itself, never loads Pi's built-in extensions, and doesn't run Pi's
 * interactive mode.
 */
export declare const PI_EXTENSION_LOAD_FAILURE_HINT = "Hint: Start without extensions using \"pi -ne\".";
export declare const EXTENSION_LOAD_FAILURE_HINT = "Hint: Fix the extension, or remove it from the Manifest that declares it (\"mmp list\" shows which).";
/**
 * The hint after extension load failures (`failedPaths` as Pi names them). A built-in is on by
 * default (decision H3/K4) and loads after every Manifest extension, so a third-party extension
 * registering one of its tools (`todo`, `task`, ...) shows up as the built-in failing, with no
 * Manifest declaring it: say how to turn it off. Any other failure gets the plain hint.
 */
export declare function extensionLoadFailureHint(failedPaths: readonly string[], assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">): string;
/** MMP's own login guidance: `--list-models`' empty list (dogfood D48) and, in place of Pi's, every
 * "no model / no API key" error (D55). */
export declare const PROVIDER_LOGIN_HELP: string;
/**
 * The exact text of `core/auth-guidance.js`'s `getProviderLoginHelp()` (not exported), which ends
 * Pi's "No models available." / "No model selected." / "No API key found for ..." errors with links
 * into Pi's own docs directory (docs/pi-internals.md, `pi-auth-guidance`).
 */
export declare function piProviderLoginHelp(): string;
/**
 * Dogfood D55: swaps Pi's login guidance for MMP's in text on its way to the user (a TUI notice or
 * error line, Pi's stderr, and Pi's JSON lines on stdout, where it arrives JSON-escaped). The error
 * before it ("No API key found for ...") is kept as it is. Plain or colored line by line by chalk
 * (D57); MMP's guidance is one line, so the codes inside Pi's go with it.
 */
export declare function rewritePiText(text: string): string;
/**
 * For the piMain path, where Pi itself writes: `console.error` right before `process.exit(1)` for
 * the extension hint, and `-p`'s errors, and rpc/json's JSON lines on stdout (output-guard.js takes
 * the stdout write installed here as its raw write). There is nothing to catch, so the rewrite
 * happens on the streams. Only those exact texts are replaced; everything around them passes
 * through unchanged.
 */
export declare function rewritePiOutput(assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">): void;
//# sourceMappingURL=pi-output.d.ts.map