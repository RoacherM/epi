import { type ResolvedAssembly } from "./assembly.js";
/** Epi's own hint after an extension load failure, in every mode. Pi's (`Start without extensions
 * using "pi -ne"`) names a Pi command and a flag Epi does not have (hard rule 4); nothing reaches
 * Pi's code that prints it any more (decision N1). */
export declare const EXTENSION_LOAD_FAILURE_HINT = "Hint: Fix the extension, or remove it from the Manifest that declares it (\"epi list\" shows which).";
/**
 * The hint after extension load failures (`failedPaths` as Pi names them). A built-in is on by
 * default (decision H3/K4) and loads after every Manifest extension, so a third-party extension
 * registering one of its tools (`todo`, `task`, ...) shows up as the built-in failing, with no
 * Manifest declaring it: say how to turn it off. Any other failure gets the plain hint.
 */
export declare function extensionLoadFailureHint(failedPaths: readonly string[], assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">): string;
/** Epi's own login guidance: `--list-models`' empty list (dogfood D48) and, in place of Pi's, every
 * "no model / no API key" error (D55). */
export declare const PROVIDER_LOGIN_HELP: string;
/**
 * The exact text of `core/auth-guidance.js`'s `getProviderLoginHelp()` (not exported), which ends
 * Pi's "No models available." / "No model selected." / "No API key found for ..." errors with links
 * into Pi's own docs directory (docs/pi-internals.md, `pi-auth-guidance`).
 */
export declare function piProviderLoginHelp(): string;
/**
 * Dogfood D55: swaps Pi's login guidance for Epi's in text on its way to the user (a TUI notice or
 * error line, Pi's stderr, and Pi's JSON lines on stdout, where it arrives JSON-escaped). The error
 * before it ("No API key found for ...") is kept as it is. Plain or colored line by line by chalk
 * (D57); Epi's guidance is one line, so the codes inside Pi's go with it.
 */
export declare function rewritePiText(text: string): string;
/**
 * For print/json/rpc, where Pi's mode runners write: `-p`'s errors on stderr, and rpc/json's JSON
 * lines on stdout (output-guard.js takes the stdout write installed here as its raw write). There
 * is nothing to catch, so the rewrite happens on the streams. Only Pi's login guidance is
 * replaced; everything around it passes through unchanged.
 */
export declare function rewritePiOutput(): void;
//# sourceMappingURL=pi-output.d.ts.map