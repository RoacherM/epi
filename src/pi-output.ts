import { join } from "node:path";

import { getDocsPath } from "@earendil-works/pi-coding-agent";

import { builtInOffInstruction, type ResolvedAssembly } from "./assembly.js";
import type { BuiltInExtensionName } from "./manifest.js";

/** Epi's own hint after an extension load failure, in every mode. Pi's (`Start without extensions
 * using "pi -ne"`) names a Pi command and a flag Epi does not have (hard rule 4); nothing reaches
 * Pi's code that prints it any more (decision N1). */
export const EXTENSION_LOAD_FAILURE_HINT =
  'Hint: Fix the extension, or remove it from the Manifest that declares it ("epi list" shows which).';

/** Pi names an inline extension `<inline:NAME>` in its load errors. epi:mcp also loads `codemode`
 * and `tool-search` (src/extensions/index.ts), so their failures are turned off with it. */
const BUILT_IN_PATH = /^<inline:(epi:(?:task|mcp|hooks)|codemode|tool-search)>$/;
const LOADED_WITH: Readonly<Record<string, BuiltInExtensionName>> = {
  codemode: "epi:mcp",
  "tool-search": "epi:mcp",
};

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
      'Or remove the other extension from its Manifest ("epi list" shows which).';
  });
  if (other) lines.unshift(EXTENSION_LOAD_FAILURE_HINT);
  return lines.join("\n");
}

/** Epi's own login guidance: `--list-models`' empty list (dogfood D48) and, in place of Pi's, every
 * "no model / no API key" error (D55). */
export const PROVIDER_LOGIN_HELP =
  "Log in to a provider with /login inside epi (OAuth or API key), or declare " +
  "a provider extension in the Manifest (epi install <source>, or epi config).";

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
 * Dogfood D55: swaps Pi's login guidance for Epi's in text on its way to the user (a TUI notice or
 * error line, Pi's stderr, and Pi's JSON lines on stdout, where it arrives JSON-escaped). The error
 * before it ("No API key found for ...") is kept as it is. Plain or colored line by line by chalk
 * (D57); Epi's guidance is one line, so the codes inside Pi's go with it.
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
 * For print/json/rpc, where Pi's mode runners write: `-p`'s errors on stderr, and rpc/json's JSON
 * lines on stdout (output-guard.js takes the stdout write installed here as its raw write). There
 * is nothing to catch, so the rewrite happens on the streams. Only Pi's login guidance is
 * replaced; everything around it passes through unchanged.
 */
export function rewritePiOutput(): void {
  rewriteStream(process.stderr, rewritePiText);
  rewriteStream(process.stdout, rewritePiText);
}
