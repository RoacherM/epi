import { join } from "node:path";

import { getDocsPath } from "@earendil-works/pi-coding-agent";

import { builtInOffInstruction, type ResolvedAssembly } from "./assembly.js";
import type { BuiltInExtensionName } from "./manifest.js";

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

/** Pi names an inline extension `<inline:NAME>` in its load errors. mmp:mcp also loads `codemode`
 * and `tool-search` (src/extensions/index.ts), so their failures are turned off with it. */
const BUILT_IN_PATH = /^<inline:(mmp:(?:task|mcp|hooks)|codemode|tool-search)>$/;
const LOADED_WITH: Readonly<Record<string, BuiltInExtensionName>> = {
  codemode: "mmp:mcp",
  "tool-search": "mmp:mcp",
};

/** Pi's `reportDiagnostics` line for a load error, chalk's color codes optional; anchored so other
 * output mentioning the phrase (an extension's own, stdout taken over in `-p`/json) isn't counted. */
const LOAD_ERROR_LINE = /^(?:\x1b\[[\d;]*m)*Error: Failed to load extension "([^"]*)"/gm;

/**
 * The hint after extension load failures (`failedPaths` as Pi names them). A built-in is on by
 * default (decision H3/K4) and loads after every Manifest extension, so a third-party extension
 * registering one of its tools (`todo`, `task`, ...) shows up as the built-in failing, with no
 * Manifest declaring it: say how to turn it off. Any other failure gets the plain hint.
 */
export function extensionLoadFailureHint(
  failedPaths: readonly string[],
  assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">,
): string {
  const failing = new Set<string>();
  let other = failedPaths.length === 0;
  for (const path of failedPaths) {
    const name = BUILT_IN_PATH.exec(path)?.[1];
    if (name === undefined) other = true;
    else failing.add(name);
  }
  const lines = [...failing].map((name) => {
    const builtIn = LOADED_WITH[name] ?? (name as BuiltInExtensionName);
    const what = builtIn === name
      ? `${name} is built in and on by default`
      : `${name} is loaded with ${builtIn}, which is built in and on by default`;
    return `Hint: ${what}; another extension may clash with it (a tool or command of the same ` +
      `name). Turn ${builtIn} off: ${builtInOffInstruction(builtIn, assembly)}. ` +
      'Or remove the other extension from its Manifest ("mmp list" shows which).';
  });
  if (other) lines.unshift(EXTENSION_LOAD_FAILURE_HINT);
  return lines.join("\n");
}

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

/** SGR codes around a line break: chalk closes and reopens its color at every newline, so Pi's
 * `chalk.red(formatNoModelsAvailableMessage())` on a color terminal splits the guidance there. */
const SGR_LINE_BREAK = String.raw`(?:\x1b\[[\d;]*m)*\r?\n(?:\x1b\[[\d;]*m)*`;

/**
 * Dogfood D55: swaps Pi's login guidance for MMP's in text on its way to the user (a TUI notice or
 * error line, Pi's stderr, and Pi's JSON lines on stdout, where it arrives JSON-escaped). The error
 * before it ("No API key found for ...") is kept as it is. Plain or colored line by line by chalk
 * (D57); MMP's guidance is one line, so the codes inside Pi's go with it.
 */
export function rewritePiText(text: string): string {
  if (!text.includes("Use /login to log into a provider")) return text;
  const pi = piProviderLoginHelp();
  const piJson = JSON.stringify(pi).slice(1, -1);
  const piLines = new RegExp(
    pi.split("\n").map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(SGR_LINE_BREAK),
    "g",
  );
  return text
    .replace(piLines, () => PROVIDER_LOGIN_HELP)
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
export function rewritePiOutput(assembly: Pick<ResolvedAssembly, "globalManifest" | "inlineExtensions">): void {
  // Pi prints every load error (reportDiagnostics) before the hint, each in its own write.
  const failedPaths: string[] = [];
  rewriteStream(process.stderr, (text) => {
    for (const match of text.matchAll(LOAD_ERROR_LINE)) failedPaths.push(match[1]!);
    return rewritePiText(text.includes(PI_EXTENSION_LOAD_FAILURE_HINT)
      ? text.replace(PI_EXTENSION_LOAD_FAILURE_HINT, () => extensionLoadFailureHint(failedPaths, assembly))
      : text);
  });
  rewriteStream(process.stdout, rewritePiText);
}
