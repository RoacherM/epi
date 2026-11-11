/**
 * Built-in `monitor` (plus hidden legacy `Monitor` alias), `monitor_stop`, and
 * `monitor_list` tools for `epi:task`.
 *
 * Ports Claude Code's Monitor tool (`pi-cc-monitor`) into Epi's built-in task
 * extension, storing monitor logs under `<epiHome>/runtime/monitors` and using
 * `<agentDir>/bin` in PATH so no ambient Pi directories are touched.
 */

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import {
  BATCH_WINDOW_MS,
  DEFAULT_TIMEOUT_MS,
  formatDuration,
  killTree,
  LineBatcher,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  RateLimiter,
  spawnMonitor,
  validateMonitorParams,
  type ValidatedMonitorInput,
} from "../monitor-stream.js";
import { resolveHomeDir } from "../paths.js";
import {
  createTaskMonitorBridge,
  NotificationGate,
  NotificationLedger,
  stripSystemNotificationFraming,
  withSystemNotificationFraming,
  type LedgerEntry,
  type MonitorBridgeSummary,
  type NotificationPayload,
  type TaskMonitorBridge,
} from "./task-notify.js";

export const EVENT_MESSAGE_TYPE = "Monitor";
export const LOOP_STOPPED_CHANNEL = "loop:stopped";
export const STOPPED_NOTICE = "[Monitor stopped]";

const STATUS_KEY = "monitor";
const LOG_RETENTION_MS = 3 * 86_400_000;

export type MonitorCause = "output" | "exit" | "timeout" | "error" | "closed" | "stopped" | "flooded";
export type MonitorStatus = "running" | "stopped" | "exited" | "timed_out" | "failed" | "flooded";

const CAUSE_LABEL: Record<MonitorCause, string> = {
  output: "✻ monitor",
  exit: "✻ monitor ended",
  timeout: "✻ monitor expired",
  error: "✻ monitor failed",
  closed: "✻ monitor closed",
  stopped: "✻ monitor stopped",
  flooded: "✻ monitor stopped",
};

const MONITOR_DESCRIPTION =
  "Watch a background command's stdout or a WebSocket; each line or text frame arrives as a chat notification (200ms batching, burst 10 then 1/2s). Use persistent: true for session-length watches, monitor_stop to stop early, and monitor_list to inspect.";
const MONITOR_SNIPPET = "Watch a background command's stdout or a WebSocket for streaming line events.";

export interface MonitorRecord {
  id: string; kind: "command" | "ws"; description: string;
  command: string | undefined; wsUrl: string | undefined;
  timeoutMs: number; persistent: boolean; createdAt: number;
  originSessionId: string | undefined;
  eventCount: number; suppressedCount: number; status: MonitorStatus;
  endedAt: number | undefined; exitCode: number | null | undefined;
  loopPrompt: string | undefined; outputPath: string; stderrPath: string;
  child: ChildProcess | undefined; socket: WebSocket | undefined;
  closeLog: (() => void) | undefined; timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  suppressionTimer: ReturnType<typeof setTimeout> | undefined;
  lastSuppressedLine: string | undefined;
  batcher: LineBatcher | undefined; limiter: RateLimiter;
}

export type MonitorSnapshot = {
  id: string; kind: "command" | "ws"; description: string;
  command?: string; wsUrl?: string; timeoutMs: number; persistent: boolean;
  createdAt: number; eventCount: number; suppressedCount: number; status: MonitorStatus;
  endedAt?: number; exitCode?: number | null; loopPrompt?: string; pid?: number;
  outputPath: string; stderrPath: string;
};

export interface MonitorExtensionOptions {
  epiHome: string;
  agentDir: string;
  bridge?: TaskMonitorBridge;
}

interface MonitorNoticeData {
  body: string;
  details: Record<string, unknown>;
}

function generateId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function lifetimeText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function eventsText(count: number): string {
  return count === 0 ? "no events" : `${count} event${count === 1 ? "" : "s"}`;
}

function expiryNotice(record: MonitorRecord): string {
  const after = formatDuration(record.timeoutMs);
  const suppressed = record.suppressedCount ? ` (${record.suppressedCount} suppressed)` : "";
  if (record.eventCount === 0) {
    return `[Monitor expired after ${after} with no events delivered${suppressed}. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`;
  }
  return `[Monitor expired after ${after} with ${eventsText(record.eventCount)} delivered${suppressed}. Re-arm it if you still need the watch.]`;
}

function exitNotice(record: MonitorRecord, signal: NodeJS.Signals | null): string {
  const code = record.exitCode;
  const how =
    code !== null && code !== undefined ? `exit code ${code}` : signal ? `killed by ${signal}` : "no exit code";
  const suppressed = record.suppressedCount ? `, ${record.suppressedCount} suppressed` : "";
  return `[Monitor ended — ${how}, ${eventsText(record.eventCount)} delivered${suppressed}]`;
}

function floodNotice(record: MonitorRecord, suppressedForMs: number): string {
  return `[Monitor stopped — too much output (${eventsText(record.suppressedCount)} suppressed over ${formatDuration(suppressedForMs)}). Restart it with a more selective filter.]`;
}

function suppressionNotice(count: number, lastLine?: string): string {
  const tail = lastLine ? ` (last: ${lastLine})` : "";
  return `[${eventsText(count)} suppressed${tail} — output rate too high. Consider using monitor_stop to restart this monitor with a more selective filter.]`;
}

function snapshotMonitor(record: MonitorRecord): MonitorSnapshot {
  return {
    id: record.id,
    kind: record.kind,
    description: record.description,
    ...(record.command !== undefined ? { command: record.command } : {}),
    ...(record.wsUrl !== undefined ? { wsUrl: record.wsUrl } : {}),
    timeoutMs: record.timeoutMs,
    persistent: record.persistent,
    createdAt: record.createdAt,
    eventCount: record.eventCount,
    suppressedCount: record.suppressedCount,
    status: record.status,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.loopPrompt !== undefined ? { loopPrompt: record.loopPrompt } : {}),
    ...(record.child?.pid !== undefined ? { pid: record.child.pid } : {}),
    outputPath: record.outputPath,
    stderrPath: record.stderrPath,
  };
}

function bridgeSummaryOf(record: MonitorRecord): MonitorBridgeSummary {
  return {
    id: record.id,
    kind: record.kind,
    description: record.description,
    target: record.kind === "ws" ? (record.wsUrl ?? "") : (record.command ?? ""),
    status: record.status,
    persistent: record.persistent,
    timeoutMs: record.timeoutMs,
    ...(record.child?.pid !== undefined ? { pid: record.child.pid } : {}),
    eventCount: record.eventCount,
    suppressedCount: record.suppressedCount,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    outputPath: record.outputPath,
    stderrPath: record.stderrPath,
  };
}

function monitorEnv(agentDir: string): NodeJS.ProcessEnv {
  const binDir = path.join(agentDir, "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = process.env[pathKey] ?? "";
  const entries = current.split(path.delimiter).filter(Boolean);
  const updated = entries.includes(binDir) ? current : [binDir, ...entries].join(path.delimiter);
  return { ...process.env, [pathKey]: updated };
}

function expandHome(file: string): string {
  const home = resolveHomeDir(process.env);
  if (file === "~") return home;
  if (file.startsWith("~/") || (process.platform === "win32" && file.startsWith("~\\"))) {
    return path.join(home, file.slice(2));
  }
  return file;
}

function cleanOldLogs(dir: string, now = Date.now()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".log")) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > LOG_RETENTION_MS) fs.rmSync(file, { force: true });
      } catch {
        // ignore concurrent deletion
      }
    }
  } catch {
    // best-effort cleanup
  }
}

function byteLengthOf(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

interface MonitorMessageDetails {
  description?: string;
  cause?: MonitorCause;
  eventCount?: number;
  monitorId?: string;
  exitCode?: number | null;
}

function appendMonitorMeta(container: Container, details: MonitorMessageDetails, indent: number, theme: Theme): void {
  if (!details.monitorId) return;
  const meta = [`id ${details.monitorId}`, eventsText(details.eventCount ?? 0)];
  if (details.exitCode !== undefined && details.exitCode !== null) meta.push(`exit code ${details.exitCode}`);
  container.addChild(new Text(theme.fg("dim", meta.join(" · ")), indent, 0));
}

function renderMonitorMessage(
  message: { content?: unknown; details?: unknown },
  expanded: boolean,
  outputPad: number,
  theme: Theme,
): Container {
  const details = (message.details ?? {}) as MonitorMessageDetails;
  const cause = details.cause ?? "output";
  const rawContent = typeof message.content === "string" ? stripSystemNotificationFraming(message.content) : "";
  const stripped = details.monitorId ? rawContent.replace(/^monitor \S+ ·[^\n]*\n?/gm, "") : rawContent;
  const body = stripped
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
  const label = CAUSE_LABEL[cause] ?? CAUSE_LABEL.output;
  const parts = [theme.fg(cause === "output" ? "accent" : "warning", theme.bold(label))];
  if (details.description) parts.push(theme.fg("dim", details.description));

  const container = new Container();
  container.addChild(new Text(parts.join(theme.fg("dim", " · ")), outputPad, 0));
  const indent = outputPad + 2;
  const shown = expanded ? body : body.slice(0, 3);
  for (const line of shown) container.addChild(new Text(theme.fg("customMessageText", line), indent, 0));
  if (!expanded && body.length > shown.length) {
    container.addChild(new Text(theme.fg("dim", `+${body.length - shown.length} more lines`), indent, 0));
  }
  if (expanded) appendMonitorMeta(container, details, indent, theme);
  return container;
}

function buildMonitorPayload(entries: Array<LedgerEntry<MonitorNoticeData>>): NotificationPayload {
  const latest = entries[entries.length - 1]!.data.details;
  const ids = new Set(entries.map((e) => e.data.details.monitorId));
  const mergedLines = entries.flatMap((e) => (e.data.details.lines as string[] | undefined) ?? []);
  const baseDetails = ids.size === 1
    ? { ...latest, lines: mergedLines }
    : { cause: latest.cause, lines: mergedLines };
  return {
    customType: EVENT_MESSAGE_TYPE,
    content: withSystemNotificationFraming(entries.map((e) => e.data.body).join("\n\n")),
    display: true,
    details: {
      ...baseDetails,
      receipts: entries.map((e) => `${e.key}:${e.run}`),
    },
  };
}

interface EndingSpec {
  status: Exclude<MonitorStatus, "running">;
  cause: MonitorCause;
  notice?: () => string;
  flush?: boolean;
  kill?: boolean;
}

class MonitorController {
  readonly monitors = new Map<string, MonitorRecord>();
  readonly gate = new NotificationGate();
  readonly bridge: TaskMonitorBridge;
  readonly ledger: NotificationLedger<MonitorNoticeData>;
  private readonly logDir: string;
  private noticeSeq = 0;
  private disposed = false;
  private lastStatusText: string | undefined;
  private statusSet = false;
  private exitHookInstalled = false;
  private readonly killAllNow = (): void => {
    for (const record of this.monitors.values()) {
      if (record.status === "running") killTree(record.child, "SIGKILL");
    }
  };

  constructor(private readonly options: MonitorExtensionOptions) {
    this.logDir = path.join(options.epiHome, "runtime", "monitors");
    this.bridge = options.bridge ?? createTaskMonitorBridge();
    this.bridge.registerMonitorProvider({
      list: () => [...this.monitors.values()].map(bridgeSummaryOf),
      get: (id) => {
        const rec = this.monitors.get(id);
        return rec ? bridgeSummaryOf(rec) : undefined;
      },
    });
    this.ledger = new NotificationLedger<MonitorNoticeData>({
      customType: EVENT_MESSAGE_TYPE,
      coalesceMs: 0,
      gate: this.gate,
      buildPayload: buildMonitorPayload,
    });
  }

  bindSession(pi: ExtensionAPI): () => void {
    this.disposed = false;
    this.gate.bindPi(pi);
    return pi.events.on(LOOP_STOPPED_CHANNEL, (data) => this.onLoopStopped(data));
  }

  setLastCtx(ctx: ExtensionContext): void {
    this.gate.ctx = ctx;
  }

  cleanLogs(): void {
    cleanOldLogs(this.logDir);
    this.lastStatusText = undefined;
    this.refreshStatus();
  }

  arm(input: ValidatedMonitorInput, ctx: ExtensionContext): MonitorRecord {
    this.disposed = false;
    this.gate.ctx = ctx;
    fs.mkdirSync(this.logDir, { recursive: true });
    const record = this.createRecord(input);
    if (input.target.kind === "command") {
      this.startCommandMonitor(record, input.target.command, ctx);
    } else {
      this.startWsMonitor(record, input.target.url, input.target.protocols);
    }
    this.armDeadline(record);
    this.refreshStatus();
    return record;
  }

  stopById(id: string): { stopped: boolean; record?: MonitorRecord } {
    const record = this.monitors.get(id);
    if (!record || record.status !== "running") return { stopped: false, ...(record ? { record } : {}) };
    this.endMonitor(record, {
      status: "stopped",
      cause: "stopped",
      flush: true,
      kill: true,
      notice: () => STOPPED_NOTICE,
    });
    return { stopped: true, record };
  }

  onSessionShutdown(reason: string | undefined): void {
    const prevCtx = this.gate.ctx;
    this.gate.onSessionShutdown();
    if (reason === "reload") return;
    if (reason === "new" || reason === "resume" || reason === "fork") {
      for (const record of [...this.monitors.values()]) {
        if (!record.persistent && record.status === "running") {
          this.endMonitor(record, { status: "stopped", cause: "stopped", kill: true });
        }
      }
      return;
    }
    this.shutdown(prevCtx);
  }

  shutdown(statusCtx = this.gate.ctx): void {
    this.disposed = true;
    for (const record of [...this.monitors.values()]) {
      this.endMonitor(record, { status: "stopped", cause: "stopped", kill: true });
    }
    this.removeExitHook();
    this.monitors.clear();
    this.ledger.clear();
    if (this.statusSet) {
      this.statusSet = false;
      this.lastStatusText = undefined;
      try {
        statusCtx?.ui?.setStatus?.(STATUS_KEY, undefined);
      } catch {
        // ignore stale UI context
      }
    }
    this.bridge.notifyMonitorChanged();
  }

  private createRecord(input: ValidatedMonitorInput): MonitorRecord {
    const id = generateId();
    const record: MonitorRecord = {
      id,
      kind: input.target.kind,
      description: input.description,
      command: input.target.kind === "command" ? input.target.command : undefined,
      wsUrl: input.target.kind === "ws" ? input.target.url : undefined,
      timeoutMs: input.persistent ? 0 : input.timeoutMs,
      persistent: input.persistent,
      createdAt: Date.now(),
      originSessionId: this.gate.sessionId(),
      eventCount: 0,
      suppressedCount: 0,
      status: "running",
      endedAt: undefined,
      exitCode: undefined,
      loopPrompt: input.loopPrompt,
      outputPath: path.join(this.logDir, `${id}.out.log`),
      stderrPath: path.join(this.logDir, `${id}.err.log`),
      child: undefined,
      socket: undefined,
      closeLog: undefined,
      timeoutTimer: undefined,
      suppressionTimer: undefined,
      lastSuppressedLine: undefined,
      batcher: undefined,
      limiter: new RateLimiter(),
    };
    record.batcher = new LineBatcher({
      windowMs: BATCH_WINDOW_MS,
      onBatch: (lines, count) => this.onBatch(record, lines, count),
    });
    this.monitors.set(id, record);
    return record;
  }

  private armDeadline(record: MonitorRecord): void {
    if (record.persistent || record.status !== "running") return;
    record.timeoutTimer = setTimeout(() => {
      this.endMonitor(record, {
        status: "timed_out",
        cause: "timeout",
        flush: true,
        kill: true,
        notice: () => expiryNotice(record),
      });
    }, record.timeoutMs);
    record.timeoutTimer.unref?.();
  }

  private onLoopStopped(data: unknown): void {
    const payload = data as { prompt?: string } | undefined;
    const ended = payload?.prompt?.trim().replace(/^\/loop\s+/i, "").trim();
    if (!ended) return;
    for (const record of [...this.monitors.values()]) {
      const bound = record.loopPrompt?.trim().replace(/^\/loop\s+/i, "").trim();
      if (bound === ended && record.status === "running") {
        this.endMonitor(record, { status: "stopped", cause: "stopped", kill: true });
      }
    }
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    process.on("exit", this.killAllNow);
    this.exitHookInstalled = true;
  }

  private removeExitHook(): void {
    if (!this.exitHookInstalled) return;
    process.off("exit", this.killAllNow);
    this.exitHookInstalled = false;
  }

  private refreshStatus(): void {
    this.bridge.notifyMonitorChanged();
    if (this.bridge.hasTaskProvider()) return;
    const ctx = this.gate.ctx;
    if (this.disposed || !ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") return;
    const running = [...this.monitors.values()].filter((r) => r.status === "running").length;
    const text = running > 0 ? `monitor ${running}` : undefined;
    if (text === this.lastStatusText && (text !== undefined || !this.statusSet)) return;
    this.lastStatusText = text;
    this.statusSet = text !== undefined;
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // ignore stale UI context
    }
  }

  private deliver(record: MonitorRecord, cause: MonitorCause, lines: string[]): void {
    if (this.disposed) return;
    const key = `${record.id}:${++this.noticeSeq}`;
    this.ledger.put(
      key,
      {
        body: `monitor ${record.id} · ${record.description}\n${lines.join("\n")}`,
        details: {
          monitorId: record.id,
          description: record.description,
          cause,
          lines: cause === "output" ? lines : [],
          eventCount: record.eventCount,
          exitCode: record.exitCode,
          outputPath: record.outputPath,
          stderrPath: record.stderrPath,
          ...(record.loopPrompt ? { loopPrompt: record.loopPrompt } : {}),
        },
      },
      0,
      true,
      record.originSessionId,
    );
  }

  private clearSuppressionTimer(record: MonitorRecord): void {
    if (!record.suppressionTimer) return;
    clearTimeout(record.suppressionTimer);
    record.suppressionTimer = undefined;
  }

  private scheduleSuppressedTailFlush(record: MonitorRecord): void {
    if (record.suppressionTimer || record.status !== "running") return;
    record.suppressionTimer = setTimeout(() => {
      record.suppressionTimer = undefined;
      if (record.status !== "running") return;
      const flushed = record.limiter.flushPendingIfReady();
      if (flushed > 0) {
        const lastLine = record.lastSuppressedLine;
        record.lastSuppressedLine = undefined;
        this.deliver(record, "output", [suppressionNotice(flushed, lastLine)]);
      }
    }, record.limiter.nextRefillDelayMs());
    record.suppressionTimer.unref?.();
  }

  private endMonitor(record: MonitorRecord, ending: EndingSpec): void {
    if (record.status !== "running") return;
    if (ending.flush) record.batcher?.flushRemainder();
    if (record.status !== "running") return;
    record.batcher?.close();
    this.clearSuppressionTimer(record);
    record.status = ending.status;
    record.endedAt = Date.now();
    if (record.timeoutTimer) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = undefined;
    }
    if (ending.kill) {
      killTree(record.child);
      try {
        record.socket?.close();
      } catch {
        // already closed
      }
    }
    record.closeLog?.();
    if (ending.notice) this.deliver(record, ending.cause, [ending.notice()]);
    if (![...this.monitors.values()].some((other) => other.status === "running")) this.removeExitHook();
    this.refreshStatus();
  }

  private onBatch(record: MonitorRecord, lines: string[], count: number): void {
    if (record.status !== "running") return;
    const verdict = record.limiter.take(count);
    if (verdict.deliver) {
      this.clearSuppressionTimer(record);
      const lastLine = record.lastSuppressedLine;
      record.lastSuppressedLine = undefined;
      record.eventCount += count;
      this.deliver(
        record,
        "output",
        verdict.suppressed ? [suppressionNotice(verdict.suppressed, lastLine), ...lines] : lines,
      );
      this.bridge.notifyMonitorChanged();
      return;
    }
    record.suppressedCount += count;
    record.lastSuppressedLine = lines.at(-1) ?? record.lastSuppressedLine;
    if (verdict.flood) {
      this.endMonitor(record, {
        status: "flooded",
        cause: "flooded",
        kill: true,
        notice: () => floodNotice(record, verdict.suppressedForMs),
      });
      return;
    }
    this.scheduleSuppressedTailFlush(record);
    this.bridge.notifyMonitorChanged();
  }

  private startCommandMonitor(record: MonitorRecord, command: string, ctx: ExtensionContext): void {
    try {
      const pi = this.gate.pi;
      const settings = pi && typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
      const shellCfg = getShellConfig(settings?.shellPath ? expandHome(settings.shellPath) : undefined);
      const fullCmd = settings?.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${command}` : command;
      record.child = spawnMonitor({
        command: fullCmd,
        cwd: ctx.cwd,
        env: monitorEnv(this.options.agentDir),
        shell: shellCfg.shell,
        shellArgs: shellCfg.args,
        commandTransport: shellCfg.commandTransport ?? "argv",
        stdoutPath: record.outputPath,
        stderrPath: record.stderrPath,
        onStdout: (chunk) => {
          if (record.status === "running") record.batcher?.push(chunk);
        },
        onExit: (code, signal) => {
          record.exitCode = code;
          this.endMonitor(record, {
            status: "exited",
            cause: "exit",
            flush: true,
            notice: () => exitNotice(record, signal),
          });
        },
        onError: (error) => {
          this.endMonitor(record, {
            status: "failed",
            cause: "error",
            kill: true,
            notice: () => `[Monitor failed — ${error.message}]`,
          });
        },
      });
    } catch (error) {
      this.endMonitor(record, { status: "failed", cause: "error" });
      throw new Error(`Could not start the monitor: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.installExitHook();
  }

  private startWsMonitor(record: MonitorRecord, url: string, protocols: string[] | undefined): void {
    const fd = fs.openSync(record.outputPath, "a");
    const stream = fs.createWriteStream(record.outputPath, { fd, flags: "a" });
    stream.on("error", () => {});
    record.closeLog = () => stream.end();
    try {
      const socket = protocols?.length ? new WebSocket(url, protocols) : new WebSocket(url);
      record.socket = socket;
      socket.addEventListener("message", (event: MessageEvent) => {
        if (record.status !== "running") return;
        const data = event.data;
        const line = typeof data === "string" ? data : `[binary frame, ${byteLengthOf(data)} bytes]`;
        stream.write(`${line}\n`);
        record.batcher?.pushEvent(line);
      });
      socket.addEventListener("error", () => {
        this.endMonitor(record, {
          status: "failed",
          cause: "error",
          flush: true,
          kill: true,
          notice: () => "[WebSocket error]",
        });
      });
      socket.addEventListener("close", (event: { code: number }) => {
        this.endMonitor(record, {
          status: "exited",
          cause: "closed",
          flush: true,
          notice: () => `[WebSocket closed: ${event.code}]`,
        });
      });
    } catch (error) {
      this.endMonitor(record, { status: "failed", cause: "error" });
      throw new Error(`Could not start the monitor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const MONITOR_PARAMETERS = Type.Object({
  command: Type.Optional(Type.String({ description: "Shell command; each stdout line is an event" })),
  ws: Type.Optional(
    Type.Object(
      {
        url: Type.String({ description: "ASCII ws:// or wss:// URL without userinfo" }),
        protocols: Type.Optional(Type.Array(Type.String(), { description: "WebSocket subprotocols" })),
      },
      { description: "WebSocket target (mutually exclusive with command)" },
    ),
  ),
  description: Type.String({ description: "Short label shown in notifications" }),
  timeout_ms: Type.Optional(
    Type.Number({
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      description: `Deadline in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
    }),
  ),
  persistent: Type.Optional(Type.Boolean({ description: "Run until stopped or session ends" })),
  loopPrompt: Type.Optional(Type.String({ description: "Optional /loop prompt to bind lifetime to" })),
});

async function executeMonitorArm(
  controller: MonitorController,
  params: {
    command?: string;
    ws?: { url: string; protocols?: string[] };
    description: string;
    timeout_ms?: number;
    persistent?: boolean;
    loopPrompt?: string;
  },
  ctx: ExtensionContext,
) {
  controller.setLastCtx(ctx);
  const validated = validateMonitorParams(params);
  const record = controller.arm(validated, ctx);
  const lifetime = record.persistent
    ? "runs until you stop it or the session ends"
    : `expires in ${lifetimeText(record.timeoutMs)} unless the source ends first; you get one notice at expiry — re-arm if you still need the watch`;
  const value = {
    taskId: record.id,
    timeoutMs: record.timeoutMs,
    persistent: record.persistent,
    kind: record.kind,
    outputPath: record.outputPath,
    stderrPath: record.stderrPath,
  };
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Monitor started (task ${record.id}, ${lifetime}). You will be notified on each event. ` +
          "Keep working — do not poll or sleep. " +
          "Events may arrive while you are waiting for the user — an event is not their reply.",
      },
    ],
    details: value,
    structuredContent: value,
  };
}

function registerMonitorTool(pi: ExtensionAPI, controller: MonitorController): void {
  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description: MONITOR_DESCRIPTION,
    promptSnippet: MONITOR_SNIPPET,
    parameters: MONITOR_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => executeMonitorArm(controller, params, ctx),
  });
  pi.registerTool({
    name: "Monitor",
    label: "Monitor",
    description: MONITOR_DESCRIPTION,
    parameters: MONITOR_PARAMETERS,
    prepareLoadout: () => ({ hiddenDeclarations: ["Monitor"] }),
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => executeMonitorArm(controller, params, ctx),
  });
}

function registerMonitorStopTool(pi: ExtensionAPI, controller: MonitorController): void {
  pi.registerTool({
    name: "monitor_stop",
    label: "Stop Monitor",
    description: "Stop a running monitor by id and kill its process tree.",
    parameters: Type.Object({
      id: Type.String({ description: "Monitor id returned by monitor" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      controller.setLastCtx(ctx);
      const { stopped, record } = controller.stopById(params.id);
      if (!record) {
        const hint = controller.bridge.hasTaskJob(params.id)
          ? ` (that ID belongs to a subagent task — use task_cancel({ jobId: "${params.id}" }) instead)`
          : "";
        const value = { stopped: false, id: params.id };
        return {
          content: [{ type: "text" as const, text: `No monitor found with ID: ${params.id}${hint}` }],
          details: value,
          structuredContent: value,
        };
      }
      if (!stopped) {
        const value = { stopped: false, id: params.id, status: record.status };
        return {
          content: [{ type: "text" as const, text: `Monitor ${params.id} is not running (${record.status}).` }],
          details: value,
          structuredContent: value,
        };
      }
      const value = { stopped: true, id: params.id };
      return {
        content: [{ type: "text" as const, text: `Successfully stopped monitor: ${params.id} (${record.description})` }],
        details: value,
        structuredContent: value,
      };
    },
  });
}

function formatMonitorListLine(record: MonitorSnapshot): string {
  const age = Math.round(((record.endedAt ?? Date.now()) - record.createdAt) / 1000);
  const code =
    record.status !== "running" && record.exitCode !== undefined && record.exitCode !== null
      ? `exit ${record.exitCode}  `
      : "";
  const suppressed = record.suppressedCount ? `  ${record.suppressedCount} suppressed` : "";
  const target = record.kind === "ws" ? record.wsUrl : record.command;
  return `${record.id}  ${record.status}  ${record.kind}  ${record.eventCount} events${suppressed}  ${age}s  ${code}${record.description}  ${target ?? ""}`;
}

function registerMonitorListTool(pi: ExtensionAPI, controller: MonitorController): void {
  pi.registerTool({
    name: "monitor_list",
    label: "List Monitors",
    description: "List monitors of this session with status, event counts and exit codes.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      controller.setLastCtx(ctx);
      const list = [...controller.monitors.values()].map(snapshotMonitor);
      const text = list.length === 0 ? "No monitors." : list.map(formatMonitorListLine).join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { monitors: list },
        structuredContent: { monitors: list },
      };
    },
  });
}

export function createMonitorInlineExtension(options: MonitorExtensionOptions): InlineExtension {
  const controller = new MonitorController(options);
  return {
    name: "epi:monitor",
    factory(pi) {
      const unbindLoop = controller.bindSession(pi);
      pi.registerMessageRenderer?.(EVENT_MESSAGE_TYPE, (message, renderOpts, theme) =>
        renderMonitorMessage(message, renderOpts.expanded, renderOpts.outputPad, theme),
      );
      registerMonitorTool(pi, controller);
      registerMonitorStopTool(pi, controller);
      registerMonitorListTool(pi, controller);
      controller.ledger.bindEvents(pi, () => controller.cleanLogs());
      pi.on("session_shutdown", (event) => {
        unbindLoop();
        controller.onSessionShutdown((event as { reason?: string } | undefined)?.reason);
      });
    },
  };
}
