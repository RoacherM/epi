/**
 * Stream batching, token-bucket rate limiting, validation, and process group
 * lifecycle for the built-in `Monitor` tool (`epi:task`).
 *
 * Mirrors Claude Code's Monitor semantics and `pi-cc-monitor`:
 * - Lines within 200ms are batched into a single notification.
 * - Each line is capped at 500 chars, each batch at 3000 chars, and partial
 *   unterminated lines keep at most their last 1 MiB.
 * - Notifications are rate-limited to a burst of 10, refilling 1 token per 2s;
 *   sustained suppression over 30s stops the monitor as flooded.
 * - Command monitors run in a detached process group so `killTree` terminates
 *   backgrounded children too.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
export const MAX_LINE_CHARS = 500;
export const MAX_BATCH_CHARS = 3000;
export const MAX_PARTIAL_LINE_CHARS = 1_048_576;
export const TRUNCATED = "...(truncated)";
export const BATCH_WINDOW_MS = 200;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MIN_TIMEOUT_MS = 1_000;
function clipBatchLines(pending, cap) {
    const clipped = [];
    let size = 0;
    for (const frame of pending) {
        const separator = clipped.length > 0 ? 1 : 0;
        const remaining = cap - size - separator;
        if (remaining < 0)
            break;
        clipped.push(frame.slice(0, remaining));
        size += separator + Math.min(frame.length, remaining);
        if (remaining < frame.length)
            break;
    }
    return [...clipped, TRUNCATED];
}
export class LineBatcher {
    options;
    buffer = "";
    pending = [];
    timer = null;
    decoder = new StringDecoder("utf8");
    closed = false;
    constructor(options) {
        this.options = options;
    }
    push(chunk) {
        if (this.closed)
            return;
        this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
            this.accept(this.buffer.slice(0, index));
            this.buffer = this.buffer.slice(index + 1);
        }
        const cap = this.options.maxPartialLineChars ?? MAX_PARTIAL_LINE_CHARS;
        if (this.buffer.length > cap)
            this.buffer = this.buffer.slice(-cap);
    }
    pushEvent(frame) { if (!this.closed)
        this.accept(frame, false); }
    flush() {
        this.clearTimer();
        if (this.pending.length === 0)
            return;
        const pending = this.pending;
        this.pending = [];
        const cap = this.options.maxBatchChars ?? MAX_BATCH_CHARS;
        const lines = pending.join("\n").length > cap ? clipBatchLines(pending, cap) : pending;
        this.options.onBatch(lines, pending.length);
    }
    flushRemainder() {
        if (this.closed)
            return;
        const rest = this.buffer + this.decoder.end();
        this.buffer = "";
        if (rest)
            this.accept(rest);
        this.flush();
    }
    close() { this.closed = true; this.clearTimer(); this.pending = []; this.buffer = ""; }
    accept(raw, trim = true) {
        const line = trim ? raw.trimEnd() : raw;
        if (trim && !line)
            return;
        this.options.onLine?.(line);
        const cap = this.options.maxLineChars ?? MAX_LINE_CHARS;
        this.pending.push(line.length > cap ? `${line.slice(0, cap)}${TRUNCATED}` : line);
        if (!this.timer) {
            this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.options.windowMs);
            this.timer.unref?.();
        }
    }
    clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
export const BUCKET_CAPACITY = 10;
export const TOKEN_REFILL_MS = 2_000;
export const SUSTAINED_SUPPRESSION_KILL_MS = 30_000;
export const QUIET_GAP_MS = TOKEN_REFILL_MS * 3;
export class RateLimiter {
    options;
    tokens;
    refilledAt;
    pending = 0;
    suppressionStart;
    lastSuppressedAt;
    constructor(options = {}) {
        this.options = options;
        this.tokens = options.capacity ?? BUCKET_CAPACITY;
        this.refilledAt = (this.options.now ?? Date.now)();
    }
    take(count) {
        const now = (this.options.now ?? Date.now)();
        this.refill(now);
        if (this.tokens > 0) {
            this.tokens -= 1;
            const suppressed = this.pending;
            this.pending = 0;
            if (this.lastSuppressedAt !== undefined && now - this.lastSuppressedAt > (this.options.quietGapMs ?? QUIET_GAP_MS)) {
                this.suppressionStart = undefined;
            }
            return { deliver: true, suppressed };
        }
        this.pending += count;
        this.lastSuppressedAt = now;
        this.suppressionStart ??= now;
        const suppressedForMs = now - this.suppressionStart;
        return { deliver: false, flood: suppressedForMs > (this.options.killAfterMs ?? SUSTAINED_SUPPRESSION_KILL_MS), suppressedForMs };
    }
    refill(now) {
        const refillMs = this.options.refillMs ?? TOKEN_REFILL_MS;
        const earned = Math.floor((now - this.refilledAt) / refillMs);
        if (earned <= 0)
            return;
        this.tokens = Math.min(this.options.capacity ?? BUCKET_CAPACITY, this.tokens + earned);
        this.refilledAt += earned * refillMs;
    }
}
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const RFC6455_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const WS_URL_ERROR = "url must be a valid ASCII ws:// or wss:// URL with no userinfo and no tabs or newlines";
export function isValidWsUrl(value) {
    if (!/^[\x00-\x7F]*$/.test(value) || /[\t\n\r]/.test(value))
        return false;
    try {
        const url = new URL(value);
        if (url.protocol !== "ws:" && url.protocol !== "wss:")
            return false;
        return !url.username && !url.password;
    }
    catch {
        return false;
    }
}
export function isValidProtocols(protocols) {
    if (!protocols)
        return true;
    if (new Set(protocols).size !== protocols.length)
        return false;
    return protocols.every((p) => RFC6455_TOKEN.test(p));
}
function resolveWsTarget(wsUrl, protocols) {
    if (!isValidWsUrl(wsUrl))
        throw new Error(WS_URL_ERROR);
    if (!isValidProtocols(protocols))
        throw new Error("protocols must be unique RFC 6455 tokens");
    return { kind: "ws", url: wsUrl, protocols };
}
function resolveTarget(params) {
    const command = typeof params.command === "string" ? params.command : undefined;
    const commandText = command ?? "";
    const wsUrl = typeof params.ws?.url === "string" ? params.ws.url.trim() : "";
    const hasCommand = commandText.trim() !== "";
    const hasWs = wsUrl !== "";
    if (hasCommand && hasWs)
        throw new Error("exactly one of command or ws");
    if (!hasCommand && !hasWs) {
        if (command !== undefined)
            throw new Error("command must not be empty");
        throw new Error(params.ws !== undefined ? WS_URL_ERROR : "exactly one of command or ws");
    }
    if (!hasCommand)
        return resolveWsTarget(wsUrl, params.ws?.protocols);
    if (CONTROL_CHARS.test(commandText)) {
        throw new Error("command contains control characters that would be hidden in the approval dialog");
    }
    return { kind: "command", command: commandText };
}
export function validateMonitorParams(params) {
    const target = resolveTarget(params);
    if (!params.description?.trim())
        throw new Error("description is required");
    const persistent = params.persistent ?? false;
    const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (!persistent) {
        if (timeoutMs < MIN_TIMEOUT_MS)
            throw new Error(`timeout_ms must be ≥ ${MIN_TIMEOUT_MS}`);
        if (timeoutMs > MAX_TIMEOUT_MS)
            throw new Error(`timeout_ms must be ≤ ${MAX_TIMEOUT_MS}`);
    }
    return {
        description: params.description,
        timeoutMs,
        persistent,
        loopPrompt: params.loopPrompt,
        target,
    };
}
const KILL_ESCALATION_MS = 2000;
export function spawnMonitor(options) {
    const stdoutStream = fs.createWriteStream(options.stdoutPath, { flags: "a" });
    const stderrStream = fs.createWriteStream(options.stderrPath, { flags: "a" });
    stdoutStream.on("error", () => { });
    stderrStream.on("error", () => { });
    const useStdin = options.commandTransport === "stdin";
    let child;
    try {
        child = spawn(options.shell, useStdin ? options.shellArgs : [...options.shellArgs, options.command], {
            cwd: options.cwd,
            env: options.env,
            detached: process.platform !== "win32",
            stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
            windowsHide: true,
        });
    }
    catch (error) {
        stdoutStream.end();
        stderrStream.end();
        throw error;
    }
    if (useStdin) {
        child.stdin?.on("error", () => { });
        child.stdin?.end(options.command);
    }
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);
    child.stdout?.on("data", options.onStdout);
    child.on("error", (error) => options.onError(error));
    child.on("close", (code, signal) => {
        stdoutStream.end();
        stderrStream.end();
        options.onExit(code, signal);
    });
    return child;
}
export function killTree(child, signal = "SIGTERM") {
    if (!child || child.pid === undefined)
        return;
    const pid = child.pid;
    if (process.platform === "win32") {
        try {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        }
        catch {
            try {
                child.kill(signal);
            }
            catch {
                // already gone
            }
        }
        return;
    }
    const signalGroup = (sig) => {
        try {
            process.kill(-pid, sig);
        }
        catch {
            try {
                child.kill(sig);
            }
            catch {
                // already gone
            }
        }
    };
    signalGroup(signal);
    if (signal !== "SIGKILL") {
        const escalate = setTimeout(() => {
            try {
                process.kill(-pid, 0);
                signalGroup("SIGKILL");
            }
            catch {
                // gone
            }
        }, KILL_ESCALATION_MS);
        escalate.unref?.();
    }
}
export function formatDuration(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
//# sourceMappingURL=monitor-stream.js.map