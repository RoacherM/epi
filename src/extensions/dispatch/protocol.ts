// The parent <-> worker JSONL protocol on `fd 3` (docs/dispatch-design.md §2.1). Using a dedicated
// descriptor instead of stdout means a plugin or MCP server printing to fd 1 can never corrupt it,
// and no Pi-internal stdout takeover is needed. Both directions share the one socket pair.
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";

import type { SteerStrategy, TaskUsage } from "./types.js";

export const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
export const CAPSULE_VERSION = 1;

export interface BoardMessage {
  seq: number;
  sender: string;
  channel: string;
  mentions: string[];
  text: string;
  timestamp: number;
}

/** What the parent hands a worker (`0600`, deleted as the worker reads it). */
export interface WorkerCapsule {
  version: 1;
  role: "task-worker" | "peer-worker";
  jobId: string;
  name?: string | undefined;
  task: string;
  cwd: string;
  agentDir: string;
  stateDir: string;
  sessionPath: string;
  forkEntries?: unknown[] | undefined;
  systemPrompt: string;
  model?: string | undefined;
  tools?: string[] | undefined;
  excludeTools?: string[] | undefined;
  maxTurns?: number | undefined;
  deadlineAt: number;
  verifyCommand?: string | undefined;
  /** The host's own SDK entry, so the worker runs the exact Pi copy the parent loaded. */
  sdkEntryUrl: string;
  bootstrapModule?: string | undefined;
  bootstrapOptions?: Record<string, unknown> | undefined;
  /** Default bootstrap only: extension files the worker session loads (e.g. a provider). */
  extensionPaths?: string[] | undefined;
  boardPath?: string | undefined;
  sharedDaemonNames: string[];
}

export interface WorkerProgress {
  type: "progress";
  turns: number;
  steps: number;
  phase: "tool_start" | "tool_end" | "turn_end" | "compaction" | "report";
  tool?: string;
  target?: string;
  summary?: string;
  notifyParent?: boolean;
  reason?: "manual" | "threshold" | "overflow";
  tokensBefore?: number;
  tokensAfter?: number;
  ok?: boolean;
}

export interface WorkerResult {
  type: "result";
  ok: boolean;
  output?: string;
  error?: string;
  partial?: boolean;
  stopped?: "maxTurns" | "context" | "idle" | "verify";
  turns?: number;
  usage?: TaskUsage;
  verify?: { ok: boolean; attempts: number };
}

export type WorkerEvent =
  | { type: "started"; pid: number }
  | WorkerProgress
  | WorkerResult
  | { type: "steer_dropped"; message: string }
  | { type: "board_post"; text: string; channel?: string }
  /** Peer state for the stall detector: parked in `board_wait`, and its own finite work in flight. */
  | { type: "state"; parked: boolean; finite: number };

export type ParentCommand =
  | { type: "steer"; message: string; strategy?: SteerStrategy }
  | { type: "abort" }
  | { type: "board"; message: BoardMessage };

/** Newline-delimited JSON over a duplex stream; a malformed or oversized line is reported once. */
export class JsonlChannel<In, Out> {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  protocolError: string | undefined;

  constructor(
    private readonly stream: Duplex,
    private readonly onMessage: (message: In) => void,
    onClose: () => void,
  ) {
    stream.on("data", (chunk: Buffer | string) => this.receive(typeof chunk === "string" ? chunk : this.decoder.write(chunk)));
    stream.on("end", onClose);
    stream.on("error", onClose);
    stream.on("close", onClose);
  }

  private receive(text: string): void {
    if (this.protocolError !== undefined) return;
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > MAX_PROTOCOL_LINE_BYTES) {
      this.protocolError = "worker protocol line exceeded the 16 MiB limit";
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.parse(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private parse(line: string): void {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.protocolError = "invalid JSONL on the dispatch channel";
      return;
    }
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) this.onMessage(parsed as In);
  }

  /** Synchronous enqueue on the socket: messages keep their call order (board_post FIFO). */
  send(message: Out): boolean {
    if (!this.stream.writable) return false;
    try {
      this.stream.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  end(): void {
    try { this.stream.end(); } catch { /* closed */ }
  }

  /** End our side and stop the socket from holding the process open. */
  release(): void {
    this.end();
    (this.stream as Partial<Socket>).unref?.();
  }
}

export type DispatchSdk = typeof import("@earendil-works/pi-coding-agent");

/** A host's worker bootstrap module (`DispatchHostAdapter.workerBootstrapModule`) exports this:
 * build the worker's session with `extensions` (the dispatch worker slice) mounted. */
export type CreateWorkerSession = (capsule: WorkerCapsule, extensions: ExtensionFactory[], sdk: DispatchSdk) => Promise<AgentSession>;
