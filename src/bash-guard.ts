import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
export const MAX_BASH_TIMEOUT_SECONDS = 600;
const MAX_STREAM_PROBE_SECONDS = 60;
const MAX_SHELL_UNWRAP_DEPTH = 3;

export type BashTimeoutCheck =
  | { action: "allow"; timeoutSeconds: number; defaulted: boolean }
  | { action: "block"; reason: string };

export interface BashGuardOptions {
  effectiveTimeoutSec: number;
  timeoutDefaulted: boolean;
  hasMonitorTool: boolean;
}

export type BashCommandCheck =
  | { blocked: false }
  | { blocked: true; kind: "detached-daemon" | "stream-follow" | "interactive-tui" | "unwaited-background"; reason: string };

interface ShellSegment { text: string; sep: string }
interface HeredocSpec { stripTabs: boolean; delim: string }
interface LexerState {
  segments: ShellSegment[];
  heredocs: HeredocSpec[];
  cur: string;
  quote: "'" | '"' | null;
  substDepth: number;
}
interface SegmentContext {
  options: BashGuardOptions;
  cleanedUp: boolean;
  depth: number;
  inheritedBoundSec: number | undefined;
}

const DETACHED_BINS = new Set(["nohup", "setsid", "disown", "daemonize"]);
const INTERACTIVE_BINS = new Set(["vim", "vi", "nvim", "nano", "pico", "htop", "btop", "script", "expect", "unbuffer"]);
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash"]);
const ENV_VALUE_FLAGS = new Set(["-u"]);
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-C"]);
const EMPTY_FLAGS = new Set<string>();
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "-s", "--kill-after", "--signal"]);
const WRAPPER_FLAGS_BY_BIN = new Map<string, Set<string>>([
  ["nice", new Set(["-n"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["caffeinate", new Set(["-t", "-w"])],
  ["time", EMPTY_FLAGS],
]);

function longRunningGuidance(hasMonitorTool: boolean, snapshotHint: string): string {
  return hasMonitorTool
    ? `Use ${snapshotHint} for a bounded check, \`timeout 15 ...\` for a short probe (<=60s), or \`monitor\` / \`task({ background: true })\` for managed background streams and daemons.`
    : `Use ${snapshotHint} for a bounded check, a bounded poll loop, or return the log path and wake condition so the parent session can arm \`monitor\`.`;
}

export function normalizeBashTimeout(rawTimeout: unknown, hasMonitorTool = true): BashTimeoutCheck {
  if (rawTimeout === undefined) return { action: "allow", timeoutSeconds: DEFAULT_BASH_TIMEOUT_SECONDS, defaulted: true };
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    return {
      action: "block",
      reason: `Invalid bash timeout (${String(rawTimeout)}): \`bash.timeout\` must be a positive number in SECONDS (default: ${DEFAULT_BASH_TIMEOUT_SECONDS}s, max: ${MAX_BASH_TIMEOUT_SECONDS}s).`,
    };
  }
  const delegate = hasMonitorTool ? "use `task({ background: true })` or `monitor`" : "split into bounded steps (<=600s) or report back to the parent session";
  if (rawTimeout >= 1000) {
    const suggested = Math.min(MAX_BASH_TIMEOUT_SECONDS, Math.max(1, Math.round(rawTimeout / 1000)));
    return {
      action: "block",
      reason: `Invalid bash timeout: ${rawTimeout} exceeds the ${MAX_BASH_TIMEOUT_SECONDS}s maximum and looks like milliseconds. \`bash.timeout\` is measured in SECONDS (default: ${DEFAULT_BASH_TIMEOUT_SECONDS}s, max: ${MAX_BASH_TIMEOUT_SECONDS}s), not milliseconds. Did you mean \`timeout: ${suggested}\`? For commands needing >${MAX_BASH_TIMEOUT_SECONDS}s, ${delegate}.`,
    };
  }
  if (rawTimeout > MAX_BASH_TIMEOUT_SECONDS) {
    return {
      action: "block",
      reason: `Invalid bash timeout: ${rawTimeout}s exceeds the ${MAX_BASH_TIMEOUT_SECONDS}s (10m) maximum (\`bash.timeout\` is in SECONDS, default: ${DEFAULT_BASH_TIMEOUT_SECONDS}s). Pass \`timeout <= ${MAX_BASH_TIMEOUT_SECONDS}\`, or ${delegate}.`,
    };
  }
  return { action: "allow", timeoutSeconds: rawTimeout, defaulted: false };
}

function matchHeredocStart(src: string, idx: number): { spec: HeredocSpec; nextIdx: number } | undefined {
  if (src.slice(idx, idx + 2) !== "<<" || src[idx + 2] === "<" || (idx > 0 && src[idx - 1] === "<")) return undefined;
  const match = /^(-?)[ \t]*(?:\\?([A-Za-z_][A-Za-z0-9_.-]*)|'([^'\n]+)'|"([^"\n]+)")/.exec(src.slice(idx + 2));
  const delim = match ? (match[2] ?? match[3] ?? match[4] ?? "") : "";
  return match && delim ? { spec: { stripTabs: match[1] === "-", delim }, nextIdx: idx + 2 + match[0].length } : undefined;
}

function skipSingleHeredoc(src: string, start: number, spec: HeredocSpec): number {
  let pos = start;
  while (pos < src.length) {
    const nl = src.indexOf("\n", pos);
    const rawLine = (nl === -1 ? src.slice(pos) : src.slice(pos, nl)).replace(/\r$/, "");
    const candidate = spec.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
    pos = nl === -1 ? src.length : nl + 1;
    if (candidate === spec.delim) break;
  }
  return pos;
}

function consumeHeredocs(src: string, startAfterNewline: number, specs: HeredocSpec[]): number {
  let pos = startAfterNewline;
  for (const spec of specs) pos = skipSingleHeredoc(src, pos, spec);
  specs.length = 0;
  return pos;
}

function readSemicolonOrPipe(ch: string, next: string, third: string): { sep: string; step: number } {
  if (ch === ";" && next === ";" && third === "&") return { sep: ";;&", step: 3 };
  if (ch === ";" && (next === ";" || next === "&")) return { sep: `;${next}`, step: 2 };
  if (ch === "|" && (next === "|" || next === "&")) return { sep: `|${next}`, step: 2 };
  return { sep: ch, step: 1 };
}

function readOperator(src: string, idx: number): { sep: string; step: number } | undefined {
  const ch = src[idx]!;
  const next = src[idx + 1] ?? "";
  if (ch === "\n") return { sep: "\n", step: 1 };
  if (ch === ";" || ch === "|") return readSemicolonOrPipe(ch, next, src[idx + 2] ?? "");
  if (ch !== "&") return undefined;
  if (next === "&") return { sep: "&&", step: 2 };
  const prev = idx > 0 ? src[idx - 1]! : "";
  return prev === ">" || prev === "<" || next === ">" ? undefined : { sep: "&", step: 1 };
}

function stepQuotedOrSubst(src: string, i: number, st: LexerState): number | undefined {
  const ch = src[i]!;
  if (ch === "\\" && st.quote !== "'") { st.cur += src.slice(i, i + 2); return i + 2; }
  if (st.quote !== null) { if (ch === st.quote) st.quote = null; st.cur += ch; return i + 1; }
  if (ch === "'" || ch === '"') { st.quote = ch; st.cur += ch; return i + 1; }
  if (ch === "$" && src[i + 1] === "(") { st.substDepth += 1; st.cur += "$("; return i + 2; }
  if (st.substDepth > 0) {
    st.substDepth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    st.cur += ch;
    return i + 1;
  }
  return undefined;
}

function stepUnquoted(src: string, i: number, st: LexerState): number {
  const ch = src[i]!;
  if (ch === "#" && (i === 0 || /\s/.test(src[i - 1]!))) {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  const hd = matchHeredocStart(src, i);
  if (hd !== undefined) { st.heredocs.push(hd.spec); return hd.nextIdx; }
  const op = readOperator(src, i);
  if (op === undefined) { st.cur += ch; return i + 1; }
  if (st.cur.trim().length > 0) st.segments.push({ text: st.cur.trim(), sep: op.sep });
  st.cur = "";
  const next = i + op.step;
  return op.sep === "\n" && st.heredocs.length > 0 ? consumeHeredocs(src, next, st.heredocs) : next;
}

function splitShellSegments(src: string): ShellSegment[] | null {
  const st: LexerState = { segments: [], heredocs: [], cur: "", quote: null, substDepth: 0 };
  for (let i = 0; i < src.length; ) i = stepQuotedOrSubst(src, i, st) ?? stepUnquoted(src, i, st);
  if (st.quote !== null || st.substDepth > 0) return null;
  if (st.cur.trim().length > 0) st.segments.push({ text: st.cur.trim(), sep: "" });
  return st.segments;
}

function scanWord(segText: string, start: number): { word: string; next: number } {
  let word = "";
  let quote: "'" | '"' | null = null;
  let i = start;
  while (i < segText.length) {
    const ch = segText[i]!;
    if (quote === null && /\s/.test(ch)) break;
    if (ch === "\\" && quote !== "'") { if (i + 1 < segText.length) word += segText[i + 1]; i += 2; continue; }
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
    else word += ch;
    i += 1;
  }
  return { word, next: i };
}

function advanceFlaggedPrefix(tokens: string[], start: number, valueFlags: ReadonlySet<string>, allowAssign: boolean): number {
  let idx = start + 1;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok === "--") return idx + 1;
    if (valueFlags.has(tok) && idx + 1 < tokens.length) idx += 2;
    else if (tok.startsWith("-") || (allowAssign && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok))) idx += 1;
    else break;
  }
  return idx;
}

function stripEnvAndCommandPrefixes(tokens: string[]): string[] {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    const bin = basename(tok);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) idx += 1;
    else if (bin === "env") idx = advanceFlaggedPrefix(tokens, idx, ENV_VALUE_FLAGS, true);
    else if (bin === "sudo") idx = advanceFlaggedPrefix(tokens, idx, SUDO_VALUE_FLAGS, false);
    else if (bin === "command") {
      const next = advanceFlaggedPrefix(tokens, idx, EMPTY_FLAGS, false);
      if (tokens.slice(idx + 1, next).some((f) => /^-[A-Za-z]*[vV]/.test(f))) break;
      idx = next;
    } else if (bin === "exec") idx = advanceFlaggedPrefix(tokens, idx, EMPTY_FLAGS, false);
    else break;
  }
  return tokens.slice(idx);
}

function tokenizeWords(rawText: string): string[] {
  const segText = rawText.replace(/^\(+/, "").replace(/\)+$/, "").trim();
  const tokens: string[] = [];
  for (let i = 0; i < segText.length; ) {
    if (/\s/.test(segText[i]!)) { i += 1; continue; }
    const { word, next } = scanWord(segText, i);
    if (word.length > 0) tokens.push(word);
    i = next;
  }
  return stripEnvAndCommandPrefixes(tokens);
}

function parseDurationTokenSec(arg: string | undefined): number {
  const match = arg ? /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(arg.trim()) : null;
  if (!match) return Number.NaN;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * (mult[(match[2] ?? "s").toLowerCase()] ?? 1);
}

function unwrapUtilityWrappers(argv: string[]): { argv: string[]; wrapperTimeoutSec: number | undefined } {
  let cur = stripEnvAndCommandPrefixes(argv);
  let wrapperTimeoutSec: number | undefined;
  while (cur.length > 0) {
    const bin = basename(cur[0]!);
    const wrapperFlags = WRAPPER_FLAGS_BY_BIN.get(bin);
    if (bin === "timeout" || bin === "gtimeout") {
      const durIdx = advanceFlaggedPrefix(cur, 0, TIMEOUT_VALUE_FLAGS, false);
      const dur = parseDurationTokenSec(cur[durIdx]);
      if (Number.isFinite(dur)) wrapperTimeoutSec = wrapperTimeoutSec === undefined ? dur : Math.min(wrapperTimeoutSec, dur);
      cur = stripEnvAndCommandPrefixes(cur.slice(durIdx + 1));
    } else if (wrapperFlags !== undefined) {
      cur = stripEnvAndCommandPrefixes(cur.slice(advanceFlaggedPrefix(cur, 0, wrapperFlags, false)));
    } else break;
  }
  return { argv: cur, wrapperTimeoutSec };
}

function hasSelfCleanup(segments: Array<{ argv: string[] }>): boolean {
  return segments.some((seg) => {
    const u = unwrapUtilityWrappers(seg.argv).argv;
    const bin = u.length > 0 ? basename(u[0]!) : "";
    if (bin === "wait" || bin === "kill" || bin === "pkill" || bin === "killall") return true;
    return bin === "trap" && /\b(?:kill|pkill|killall|wait)\b/.test(u.slice(1).join(" "));
  });
}

function checkDetachedDaemon(rawBin: string, bin: string, args: string[], segText: string, hasMonitorTool: boolean): BashCommandCheck | undefined {
  if (DETACHED_BINS.has(rawBin) || DETACHED_BINS.has(bin)) {
    const name = DETACHED_BINS.has(rawBin) ? rawBin : bin;
    return {
      blocked: true,
      kind: "detached-daemon",
      reason: `Blocked detached background daemon in one-shot bash: \`${segText}\`.\n\`${name}\` escapes bash process tracking and leaks orphan processes. ${longRunningGuidance(hasMonitorTool, "a self-terminating script with `wait`")}`,
    };
  }
  const tmuxDetached = bin === "tmux" && (args[0] === "new-session" || args[0] === "new") && args.some((a) => a === "-d" || (/^-[A-Za-z]+$/.test(a) && a.includes("d")));
  const screenDetached = bin === "screen" && args.some((a) => /^-[A-Za-z]*(?:dm|md)[A-Za-z]*$/.test(a) || a === "-dm");
  return tmuxDetached || screenDetached
    ? { blocked: true, kind: "detached-daemon", reason: `Blocked detached multiplexer daemon (\`${bin}\`) in one-shot bash: \`${segText}\`.\n${longRunningGuidance(hasMonitorTool, "a bounded foreground command")}` }
    : undefined;
}

function hasShortOrLongFollow(tokens: string[], shortChars: string): boolean {
  const shortRe = new RegExp(`^-[A-Za-z0-9]*[${shortChars}]`);
  return tokens.some((a) => a === "--follow" || a.startsWith("--follow=") || (!a.startsWith("--") && shortRe.test(a)));
}

function streamFollowSnapshotAlt(bin: string, args: string[]): string | undefined {
  if (bin === "tail" && hasShortOrLongFollow(args, "fF")) return "`tail -n 200 <file>`";
  if (bin === "journalctl" && hasShortOrLongFollow(args, "f")) return "`journalctl -n 200 --no-pager`";
  if (bin === "dmesg" && hasShortOrLongFollow(args, "w")) return "`dmesg | tail -n 200`";
  if (bin === "docker" || bin === "kubectl" || bin === "podman") {
    const logsIdx = args.indexOf("logs");
    if (logsIdx >= 0 && hasShortOrLongFollow(args.slice(logsIdx + 1), "f")) return "`logs --tail 200` (without `-f`)";
  }
  if (bin === "watch" || bin === "fswatch") return "a single snapshot command";
  return undefined;
}

function checkStreamFollow(bin: string, args: string[], segText: string, probeBoundSec: number | undefined, hasMonitorTool: boolean): BashCommandCheck | undefined {
  if (probeBoundSec !== undefined && probeBoundSec <= MAX_STREAM_PROBE_SECONDS) return undefined;
  const alt = streamFollowSnapshotAlt(bin, args);
  if (alt !== undefined) {
    return { blocked: true, kind: "stream-follow", reason: `Blocked unbounded streaming command: \`${segText}\`.\n${longRunningGuidance(hasMonitorTool, alt)}` };
  }
  return bin === "ping" && !args.some((a) => (!a.startsWith("--") && /^-[A-Za-z]*(?:c|w|t|o)\d*$/.test(a)) || /^--(?:count|deadline|timeout)(?:=|$)/.test(a))
    ? { blocked: true, kind: "stream-follow", reason: `Blocked unbounded \`ping\` without packet/time limit: \`${segText}\`. Pass \`ping -c 4 ...\` so it terminates.` }
    : undefined;
}

function checkInteractiveTui(bin: string, args: string[], segText: string): BashCommandCheck | undefined {
  if (INTERACTIVE_BINS.has(bin) || (bin === "emacs" && (args.includes("-nw") || args.includes("--no-window-system")))) {
    return {
      blocked: true,
      kind: "interactive-tui",
      reason: `Blocked interactive terminal/PTY program \`${bin}\`: \`${segText}\`.\n\`bash\` runs headless without an interactive TTY; use \`read\` / \`edit\` / \`write\` or non-interactive CLI flags instead.`,
    };
  }
  return bin === "top" && !args.some((a) => !a.startsWith("--") && /^-[A-Za-z]*[lbn]\d*$/.test(a))
    ? { blocked: true, kind: "interactive-tui", reason: `Blocked interactive \`top\`: \`${segText}\`. Pass \`top -l 1\` (macOS) or \`top -b -n 1\` (Linux) for a single snapshot.` }
    : undefined;
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined ? Math.min(a, b) : (a ?? b);
}

function extractNestedShellScript(bin: string, args: string[]): string | undefined {
  if (!SHELL_BINS.has(bin)) return undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "-o" || arg === "--rcfile" || arg === "--init-file") && i + 1 < args.length) i += 1;
    else if ((/^-[A-Za-z]*c$/.test(arg) || arg === "--command") && typeof args[i + 1] === "string") return args[i + 1];
    else if (!arg.startsWith("-")) return undefined;
  }
  return undefined;
}

function inspectSegment(seg: ShellSegment & { argv: string[] }, ctx: SegmentContext): BashCommandCheck | undefined {
  if (seg.argv.length === 0) return undefined;
  const rawBin = basename(seg.argv[0]!);
  const unwrapped = unwrapUtilityWrappers(seg.argv);
  if (unwrapped.argv.length === 0) return undefined;
  const bin = basename(unwrapped.argv[0]!);
  const args = unwrapped.argv.slice(1);
  const explicitBound = ctx.options.timeoutDefaulted ? undefined : ctx.options.effectiveTimeoutSec;
  const probeBound = minDefined(minDefined(ctx.inheritedBoundSec, explicitBound), unwrapped.wrapperTimeoutSec);

  const daemonHit = checkDetachedDaemon(rawBin, bin, args, seg.text, ctx.options.hasMonitorTool);
  if (daemonHit !== undefined) return daemonHit;

  const nested = ctx.depth < MAX_SHELL_UNWRAP_DEPTH ? extractNestedShellScript(bin, args) : undefined;
  if (nested !== undefined) {
    const innerHit = inspectCommandAtDepth(nested, ctx.options, ctx.depth + 1, probeBound);
    if (innerHit.blocked) return innerHit;
  }

  const directHit = checkStreamFollow(bin, args, seg.text, probeBound, ctx.options.hasMonitorTool) ?? checkInteractiveTui(bin, args, seg.text);
  if (directHit !== undefined) return directHit;

  return seg.sep === "&" && !ctx.cleanedUp
    ? { blocked: true, kind: "unwaited-background", reason: `Blocked unmanaged background process (\`&\` without \`wait\`/\`kill\`): \`${seg.text} &\`. ${longRunningGuidance(ctx.options.hasMonitorTool, "`kill` + `wait` inside the same script")}` }
    : undefined;
}

function inspectCommandAtDepth(command: string, options: BashGuardOptions, depth: number, inheritedBoundSec: number | undefined): BashCommandCheck {
  const rawSegments = splitShellSegments(command);
  if (rawSegments === null) return { blocked: false };
  const parsed = rawSegments.map((seg) => ({ ...seg, argv: tokenizeWords(seg.text) }));
  const ctx: SegmentContext = { options, cleanedUp: hasSelfCleanup(parsed), depth, inheritedBoundSec };
  for (const seg of parsed) {
    const hit = inspectSegment(seg, ctx);
    if (hit !== undefined) return hit;
  }
  return { blocked: false };
}

export function analyzeBashCommand(command: string, options: BashGuardOptions): BashCommandCheck {
  try {
    return inspectCommandAtDepth(command, options, 0, undefined);
  } catch {
    return { blocked: false };
  }
}

export function augmentBashTimeoutResult(
  text: string,
  cwd: string,
  options: { defaulted: boolean; hasMonitorTool: boolean },
): string | undefined {
  const match = /Command timed out after (\d+(?:\.\d+)?) seconds/.exec(text);
  if (!match) return undefined;
  const prefix = options.defaulted ? `default ${DEFAULT_BASH_TIMEOUT_SECONDS}s bash timeout reached` : `bash timeout (${match[1]}s) reached`;
  const nextStep = options.hasMonitorTool
    ? `retry with an explicit \`timeout\` in seconds (up to ${MAX_BASH_TIMEOUT_SECONDS}s), or use \`task({ background: true })\` / \`monitor\` for long-running work.`
    : `retry with an explicit \`timeout\` in seconds (up to ${MAX_BASH_TIMEOUT_SECONDS}s), split into smaller steps, or report back to the parent session.`;
  const lockHint = existsSync(join(cwd, ".git", "index.lock"))
    ? ` Note: \`.git/index.lock\` exists in ${cwd}; verify no git process is still running before removing stale lock files.`
    : "";
  return `${text}\n[epi: ${prefix}. If this command legitimately needs longer, ${nextStep}${lockHint}]`;
}
