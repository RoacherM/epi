import { join } from "node:path";

import { getDocsPath } from "@earendil-works/pi-coding-agent";

/**
 * Pi's `main.js` ends a startup extension load failure with this hint (its unexported
 * `EXTENSION_LOAD_FAILURE_HINT`, with `APP_NAME` = "pi"). MMP has no `-ne` and exposes only its own
 * options (hard rule 4), so the line is swapped for MMP's own (docs/pi-internals.md,
 * `pi-extension-load-hint`). Pi's login guidance is swapped the same way (`rewritePiText`). Every
 * other `pi`-naming text Pi can print is out of MMP's reach: MMP handles `--help`, `auth`, `mcp` and
 * the other subcommands itself, never loads Pi's built-in extensions, and doesn't run Pi's
 * interactive mode.
 */
export const PI_EXTENSION_LOAD_FAILURE_HINT = 'Hint: Start without extensions using "pi -ne".';

export const EXTENSION_LOAD_FAILURE_HINT =
  'Hint: Fix the extension, or remove it from the Manifest that declares it ("mmp list" shows which).';

/** MMP's own login guidance: `--list-models`' empty list (dogfood D48) and, in place of Pi's, every
 * "no model / no API key" error (D55). */
export const PROVIDER_LOGIN_HELP =
  "Log in to a provider with /login inside mmp (OAuth or API key), or declare " +
  "a provider extension in the Manifest (mmp install <source>, or mmp config).";

/**
 * The exact text of `core/auth-guidance.js`'s `getProviderLoginHelp()` (not exported), which ends
 * Pi's "No models available." / "No model selected." / "No API key found for ..." errors with links
 * into Pi's own docs directory (docs/pi-internals.md, `pi-auth-guidance`).
 */
export function piProviderLoginHelp(): string {
  return [
    "Use /login to log into a provider via OAuth or API key. See:",
    `  ${join(getDocsPath(), "providers.md")}`,
    `  ${join(getDocsPath(), "models.md")}`,
  ].join("\n");
}

/**
 * Dogfood D55: swaps Pi's login guidance for MMP's in text on its way to the user (a TUI notice or
 * error line, Pi's stderr, and Pi's JSON lines on stdout, where it arrives JSON-escaped). The error
 * before it ("No API key found for ...") is kept as it is.
 */
export function rewritePiText(text: string): string {
  if (!text.includes("Use /login to log into a provider")) return text;
  const pi = piProviderLoginHelp();
  const piJson = JSON.stringify(pi).slice(1, -1);
  return text
    .replaceAll(pi, PROVIDER_LOGIN_HELP)
    .replaceAll(piJson, JSON.stringify(PROVIDER_LOGIN_HELP).slice(1, -1));
}

function rewriteStream(stream: NodeJS.WriteStream, rewrite: (text: string) => string): void {
  const write = stream.write;
  stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    const text = typeof chunk === "string" ? rewrite(chunk) : chunk;
    return (write as (...args: unknown[]) => boolean).call(this, text, ...rest);
  } as typeof stream.write;
}

/**
 * For the piMain path, where Pi itself writes: `console.error` right before `process.exit(1)` for
 * the extension hint, and `-p`'s errors, and rpc/json's JSON lines on stdout (output-guard.js takes
 * the stdout write installed here as its raw write). There is nothing to catch, so the rewrite
 * happens on the streams. Only those exact texts are replaced; everything around them passes
 * through unchanged.
 */
export function rewritePiOutput(): void {
  rewriteStream(process.stderr, (text) =>
    rewritePiText(text.includes(PI_EXTENSION_LOAD_FAILURE_HINT)
      ? text.replace(PI_EXTENSION_LOAD_FAILURE_HINT, EXTENSION_LOAD_FAILURE_HINT)
      : text));
  rewriteStream(process.stdout, rewritePiText);
}
