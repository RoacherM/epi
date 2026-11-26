#!/usr/bin/env node
// A dispatch worker process (docs/dispatch-design.md §2.2, §3.4). It reads its capsule, talks to
// the parent over fd 3 only, builds a session with the worker slice of dispatch mounted (async
// bash, own task_* items, follow-up timers, and for a named peer the board), and runs it until
// it settles: the shared drain keeps it alive while its own finite work runs, and a parent steer
// ends the drain and arrives as the next `user` prompt. `verifyCommand` gates the finish.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { dirname } from "node:path";
import { Duplex } from "node:stream";
import { CAPSULE_VERSION, JsonlChannel, resolveWorkerTools } from "./protocol.js";
import { collectEntryUsage, errorText, finalAssistantText, finalAssistantTextFromEntries, singleLine, tailLines } from "./result.js";
import { DispatchRuntime } from "./runtime.js";
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const VERIFY_OUTPUT_CHARS = 4_000;
const EXIT_SAFETY_MS = 3_000;
function readCapsule(path) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    finally {
        try {
            unlinkSync(path);
        }
        catch { /* missing */ }
    }
    const capsule = parsed;
    if (capsule === null || typeof capsule !== "object" || capsule.version !== CAPSULE_VERSION)
        throw new Error("unsupported dispatch capsule");
    for (const field of ["task", "cwd", "agentDir", "stateDir", "sessionPath", "sdkEntryUrl", "jobId"]) {
        if (typeof capsule[field] !== "string")
            throw new Error(`dispatch capsule ${field} must be a string`);
    }
    return capsule;
}
/** A fork child's session file starts with the parent's (or a peer's) closed entries; every
 * bootstrap then simply opens `sessionPath`, which is also how a settled job resumes in place. */
function writeForkEntries(capsule) {
    if (capsule.forkEntries === undefined || capsule.forkEntries.length === 0)
        return;
    const header = { type: "session", version: 3, id: `dispatch-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), cwd: capsule.cwd };
    writeFileSync(capsule.sessionPath, `${[header, ...capsule.forkEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
}
/** The portable bootstrap: a plain Pi session with only the capsule's extension files loaded. */
const defaultSession = async (capsule, extensions, sdk) => {
    const settingsManager = sdk.SettingsManager.create(capsule.cwd, capsule.agentDir, { projectTrusted: false });
    const { modelRuntime, resourceLoader, diagnostics } = await sdk.createAgentSessionServices({
        cwd: capsule.cwd, agentDir: capsule.agentDir, settingsManager,
        resourceLoaderOptions: {
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            additionalExtensionPaths: capsule.extensionPaths ?? [], extensionFactories: extensions,
            appendSystemPromptOverride: () => (capsule.systemPrompt.trim().length > 0 ? [capsule.systemPrompt] : []),
        },
    });
    const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (errors.length > 0)
        throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
    const resolved = capsule.model === undefined ? undefined : sdk.resolveCliModel({ cliModel: capsule.model, modelRuntime });
    if (resolved?.error !== undefined)
        throw new Error(resolved.error);
    const tools = resolveWorkerTools(capsule);
    const { session } = await sdk.createAgentSession({
        cwd: capsule.cwd, agentDir: capsule.agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager: sdk.SessionManager.open(capsule.sessionPath, dirname(capsule.sessionPath), capsule.cwd),
        ...(resolved?.model === undefined ? {} : { model: resolved.model }),
        ...(resolved?.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
        ...(tools === undefined ? {} : { tools }),
        ...(capsule.excludeTools === undefined ? {} : { excludeTools: capsule.excludeTools }),
    });
    await session.bindExtensions({ mode: "print" });
    return session;
};
const OVERFLOW_PATTERNS = [
    /prompt (?:is )?too long/i,
    /prompt exceeds max length/i,
    /request_too_large/i,
    /input is too long for requested model/i,
    /exceeds the context window/i,
    /exceeds (?:the )?(?:model'?s )?maximum context length/i,
    /input token count.*exceeds the maximum/i,
    /maximum prompt length is \d+/i,
    /reduce the length of the messages/i,
    /maximum context length is \d+ tokens/i,
    /exceeds (?:the )?maximum allowed input length/i,
    /input \(\d+ tokens\) is longer than the model'?s context length/i,
    /exceeds the limit of \d+/i,
    /exceeds the available context size/i,
    /greater than the context length/i,
    /context window exceeds limit/i,
    /exceeded model token limit/i,
    /too large for model with \d+ maximum context length/i,
    /prompt has [\d,]+ tokens?, but the configured context size/i,
    /model_context_window_exceeded/i,
    /prompt too long; exceeded (?:max )?context length/i,
    /range of input length should be/i,
    /context[_ ]length[_ ]exceeded/i,
    /too many tokens/i,
    /token limit exceeded/i,
    /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];
const NON_OVERFLOW_PATTERNS = [/^(?:Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];
function isOverflowErrorMessage(errorMessage) {
    if (typeof errorMessage !== "string" || errorMessage.length === 0)
        return false;
    return !NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage)) && OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
}
function assistantTokenCounts(usage) {
    if (usage === undefined)
        return { input: 0, output: 0 };
    return { input: (usage.input ?? 0) + (usage.cacheRead ?? 0), output: usage.output ?? 0 };
}
function isWindowOverflow(stopReason, input, output, contextWindow) {
    if (contextWindow === undefined)
        return false;
    if (stopReason === "stop")
        return input > contextWindow;
    return stopReason === "length" && output === 0 && input >= contextWindow * 0.99;
}
function isOverflowTokenCount(msg, contextWindow, maxTokens) {
    const { input, output } = assistantTokenCounts(msg.usage);
    if (isWindowOverflow(msg.stopReason, input, output, contextWindow))
        return true;
    return msg.stopReason === "length" && maxTokens !== undefined && maxTokens > 0 && output < maxTokens;
}
function isOverflowAssistant(msg, contextWindow, maxTokens) {
    if (msg === undefined)
        return false;
    if (msg.stopReason === "error" && isOverflowErrorMessage(msg.errorMessage))
        return true;
    return isOverflowTokenCount(msg, contextWindow, maxTokens);
}
function findLastAssistant(messages) {
    return [...messages].reverse().find((message) => message.role === "assistant");
}
function requestErrorOf(observed, messages) {
    const last = observed ?? findLastAssistant(messages);
    if (last?.stopReason !== "error")
        return undefined;
    return typeof last.errorMessage === "string" && last.errorMessage.length > 0 ? last.errorMessage : "model request failed";
}
function effectiveStopReason(observed, messages) {
    return (observed ?? findLastAssistant(messages))?.stopReason;
}
function runVerify(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const append = (chunk) => {
            output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.once("error", (error) => resolve({ code: 127, output: error.message }));
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, output });
        });
    });
}
function openProtocolStream() {
    if (!process.versions.bun) {
        return new Socket({ fd: 3, readable: true, writable: true });
    }
    // Bun's `net.Socket({ fd: 3 })` drops reads from `child_process.spawn` stdio[3], and Bun's
    // `createReadStream({ fd: 3, autoClose: false }).destroy()` ignores `autoClose: false` and closes
    // fd 3 asynchronously (double-close / EBADF). Pause the reader instead and close fd 3 once after
    // writes flush or on destroy.
    const reader = createReadStream("", { fd: 3, autoClose: false });
    const writer = createWriteStream("", { fd: 3, autoClose: false });
    let closing = false;
    let fdClosed = false;
    const closeFdOnce = () => {
        if (fdClosed)
            return;
        fdClosed = true;
        try {
            closeSync(3);
        }
        catch { /* already closed */ }
    };
    const duplex = new Duplex({
        read() { },
        write(chunk, encoding, callback) {
            writer.write(chunk, encoding, callback);
        },
        final(callback) {
            closing = true;
            reader.pause();
            writer.end(() => {
                closeFdOnce();
                callback();
            });
        },
        destroy(error, callback) {
            closing = true;
            reader.pause();
            closeFdOnce();
            callback(error);
        },
    });
    reader.on("data", (chunk) => {
        if (!closing)
            duplex.push(chunk);
    });
    reader.on("end", () => {
        if (!closing)
            duplex.push(null);
    });
    reader.on("error", (error) => {
        if (!closing)
            duplex.destroy(error);
    });
    writer.on("error", (error) => {
        if (!closing)
            duplex.destroy(error);
    });
    return duplex;
}
class Worker {
    capsule;
    session;
    interrupted = false;
    interruptRequested = false;
    hadInterrupt = false;
    /** Why this run stopped itself between turns: its `maxTurns` budget, or a peer's board idle cap. */
    budgetStop;
    inPrompt = false;
    turns = 0;
    steps = 0;
    loopFinished = false;
    overflowUnrecoverable = false;
    lastObservedAssistant;
    usageBaseline = 0;
    spent;
    pendingSteers = [];
    followUps = [];
    channel;
    runtime;
    constructor(capsule) {
        this.capsule = capsule;
        this.channel = new JsonlChannel(openProtocolStream(), (command) => this.handle(command), () => void this.interrupt());
        this.runtime = new DispatchRuntime({ sharedDaemonNames: capsule.sharedDaemonNames }, capsule.role, {
            capsule,
            emit: (event) => this.emit(event),
            steerPending: () => this.interrupted || this.stopping || this.followUps.length > 0 || this.interruptRequested,
            turns: () => this.turns,
            nextStep: () => ++this.steps,
            idleStop: () => {
                this.budgetStop = "idle";
            },
        });
    }
    emit(event) {
        this.channel.send(event);
    }
    async interrupt() {
        this.interrupted = true;
        this.runtime.barrier.wake();
        await this.session?.abort();
    }
    handle(command) {
        if (command.type === "abort")
            void this.interrupt();
        else if (command.type === "steer" && typeof command.message === "string" && command.message.length > 0)
            this.deliverSteer(command.message, command.strategy ?? "steer");
        else if (command.type === "board")
            this.runtime.peerBoard?.onPush(command.message);
    }
    /** A steer is a parent instruction, delivered verbatim (never expanded as a command). */
    deliverSteer(text, strategy) {
        if (this.loopFinished) {
            this.emit({ type: "steer_dropped", message: text });
            return;
        }
        const session = this.session;
        if (session === undefined) {
            this.pendingSteers.push({ text, strategy });
            return;
        }
        this.runtime.peerBoard?.wake("steer");
        if (strategy === "interrupt") {
            this.followUps.splice(0, this.followUps.length, text);
            this.budgetStop = undefined;
            this.stopping = false;
            if (this.inPrompt && !this.runtime.barrier.draining) {
                this.interruptRequested = true;
                this.hadInterrupt = true;
                void session.abort();
            }
            this.runtime.barrier.wake();
            return;
        }
        if (!session.isStreaming || this.runtime.barrier.draining || this.budgetStop !== undefined) {
            this.budgetStop = undefined;
            this.stopping = false;
            this.followUps.push(text);
            this.runtime.barrier.wake();
            return;
        }
        const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
        if (strategy === "enqueue")
            session.agent.followUp(message);
        else
            session.agent.steer(message);
    }
    onToolEvent(event, targets) {
        if (event.toolName === "report_progress")
            return;
        const tool = singleLine(event.toolName, 40);
        if (event.type === "tool_execution_start") {
            this.steps += 1;
            const target = toolTarget(event.args);
            targets.set(event.toolCallId, target);
            this.emit({ type: "progress", turns: this.turns, steps: this.steps, phase: "tool_start", tool, target });
            return;
        }
        const target = targets.get(event.toolCallId) ?? "";
        targets.delete(event.toolCallId);
        this.emit({ type: "progress", turns: this.turns, steps: this.steps, phase: "tool_end", tool, target });
    }
    stopping = false;
    onTurnEnd(session, event) {
        if (this.stopping || this.interruptRequested)
            return;
        this.turns += 1;
        this.emit({ type: "progress", turns: this.turns, steps: this.steps, phase: "turn_end", summary: singleLine(finalAssistantText([event.message]), 200) });
        const max = this.capsule.maxTurns;
        if (max !== undefined && this.turns >= max && event.toolResults.length > 0)
            this.budgetStop = "maxTurns";
        if (this.budgetStop !== undefined && event.toolResults.length > 0) {
            this.stopping = true;
            void session.abort();
        }
    }
    subscribe(session) {
        const targets = new Map();
        return session.subscribe((event) => {
            if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
                this.onToolEvent(event, targets);
            else if (event.type === "entry_appended")
                this.runtime.ledger.onEntryAppended(event.entry);
            else if (event.type === "turn_end")
                this.onTurnEnd(session, event);
            else if (event.type === "compaction_end") {
                const ok = event.result !== undefined && event.errorMessage === undefined;
                if (!ok && event.reason === "overflow" && !event.aborted)
                    this.overflowUnrecoverable = true;
                this.emit({
                    type: "progress", turns: this.turns, steps: this.steps, phase: "compaction", reason: event.reason, ok,
                    ...(event.result === undefined ? {} : { tokensBefore: event.result.tokensBefore, ...(event.result.estimatedTokensAfter === undefined ? {} : { tokensAfter: event.result.estimatedTokensAfter }) }),
                });
            }
        });
    }
    async promptOnce(session, text, initial) {
        this.inPrompt = true;
        try {
            await session.prompt(text, initial ? undefined : { expandPromptTemplates: false });
        }
        finally {
            this.inPrompt = false;
        }
    }
    /** One prompt plus every follow-up (steers that arrived between runs) it led to. */
    async drive(session, text, initial) {
        await this.promptOnce(session, text, initial);
        while (!this.interrupted && (this.interruptRequested || this.followUps.length > 0)) {
            this.interruptRequested = false;
            const next = this.followUps.shift();
            if (next !== undefined)
                await this.promptOnce(session, next, false);
        }
    }
    hasUnrecoveredOutcome(session) {
        const model = session.model;
        return this.overflowUnrecoverable
            || isOverflowAssistant(this.lastObservedAssistant, model?.contextWindow, model?.maxTokens)
            || requestErrorOf(this.lastObservedAssistant, session.messages) !== undefined;
    }
    /** Re-prompt on a failing verifyCommand; the same failure twice exhausts the stall budget. */
    async verifyGate(session) {
        const command = this.capsule.verifyCommand;
        if (command === undefined || this.interrupted || this.budgetStop !== undefined || this.hasUnrecoveredOutcome(session))
            return undefined;
        const seen = new Set();
        for (let attempts = 1;; attempts += 1) {
            const result = await runVerify(command, this.capsule.cwd, Math.max(1_000, Math.min(VERIFY_TIMEOUT_MS, this.capsule.deadlineAt - Date.now())));
            if (result.code === 0)
                return { ok: true, attempts, output: "" };
            const output = tailLines(result.output, 60).slice(-VERIFY_OUTPUT_CHARS);
            const fingerprint = createHash("sha256").update(output).digest("hex");
            if (seen.has(fingerprint) || attempts >= MAX_VERIFY_ATTEMPTS || this.interrupted)
                return { ok: false, attempts, output };
            seen.add(fingerprint);
            await this.drive(session, `verifyCommand \`${command}\` failed (exit ${result.code}). Fix the cause, then finish.\n${output}`, false);
            if (this.budgetStop !== undefined || this.hasUnrecoveredOutcome(session))
                return undefined;
        }
    }
    isContextStopped(session) {
        const model = session.model;
        const overflow = this.overflowUnrecoverable || isOverflowAssistant(this.lastObservedAssistant, model?.contextWindow, model?.maxTokens);
        return overflow && effectiveStopReason(this.lastObservedAssistant, session.messages) !== "stop";
    }
    resolveStopped(budget, contextStop, verifyFailed) {
        if (budget !== undefined)
            return budget;
        if (contextStop)
            return "context";
        return verifyFailed ? "verify" : undefined;
    }
    result(session, verify) {
        const entries = session.sessionManager.getEntries();
        const budget = this.stopping ? this.budgetStop : undefined;
        const contextStop = budget === undefined && this.isContextStopped(session);
        if (budget === undefined && !contextStop) {
            const requestError = requestErrorOf(this.lastObservedAssistant, session.messages);
            if (requestError !== undefined)
                throw new Error(requestError);
        }
        const output = finalAssistantTextFromEntries(entries, this.usageBaseline, budget !== undefined || contextStop || this.hadInterrupt);
        const verifyFailed = verify !== undefined && !verify.ok;
        const stopped = this.resolveStopped(budget, contextStop, verifyFailed);
        return {
            type: "result", ok: true, turns: this.turns, usage: collectEntryUsage(entries, this.usageBaseline),
            output: verifyFailed ? `${output}\n[verifyCommand still failing after ${verify.attempts} attempt(s):\n${verify.output}]` : output,
            ...(stopped === undefined ? {} : { partial: true, stopped }),
            ...(verify === undefined ? {} : { verify: { ok: verify.ok, attempts: verify.attempts } }),
        };
    }
    async bootstrap() {
        const sdk = (await import(this.capsule.sdkEntryUrl));
        writeForkEntries(this.capsule);
        const slice = (pi) => {
            this.runtime.mount(pi);
            pi.on("before_agent_start", () => { this.lastObservedAssistant = undefined; });
            pi.on("agent_end", (event) => {
                const last = findLastAssistant(event.messages);
                if (last !== undefined)
                    this.lastObservedAssistant = last;
            });
        };
        const create = this.capsule.bootstrapModule === undefined
            ? defaultSession
            : (await import(this.capsule.bootstrapModule)).createWorkerSession;
        return create(this.capsule, [slice], sdk);
    }
    async run() {
        let session;
        let unsubscribe;
        try {
            session = await this.bootstrap();
            this.session = session;
            this.usageBaseline = session.sessionManager.getEntries().length;
            for (const item of this.pendingSteers.splice(0))
                this.deliverSteer(item.text, item.strategy);
            if (this.interrupted)
                throw new Error("worker was interrupted");
            this.emit({ type: "started", pid: process.pid });
            unsubscribe = this.subscribe(session);
            await this.drive(session, this.capsule.task, true);
            let verify = await this.verifyGate(session);
            while (!this.interrupted && (this.interruptRequested || this.followUps.length > 0)) {
                this.interruptRequested = false;
                const next = this.followUps.shift();
                if (next !== undefined) {
                    await this.drive(session, next, false);
                    verify = await this.verifyGate(session);
                }
            }
            this.loopFinished = true;
            if (this.interrupted)
                throw new Error("worker was interrupted");
            this.emit(this.result(session, verify));
        }
        finally {
            this.loopFinished = true;
            unsubscribe?.();
            if (session !== undefined)
                this.spent = collectEntryUsage(session.sessionManager.getEntries(), this.usageBaseline);
            await this.runtime.shutdown();
            session?.dispose();
            this.session = undefined;
        }
    }
}
function toolTarget(args) {
    if (typeof args !== "object" || args === null)
        return "";
    for (const key of ["path", "command", "pattern", "url", "text"]) {
        const value = args[key];
        if (typeof value === "string" && value.trim().length > 0)
            return singleLine(value, 120);
    }
    return "";
}
async function main() {
    const capsulePath = process.argv[2];
    if (capsulePath === undefined)
        throw new Error("dispatch worker requires a capsule path");
    process.umask(0o077);
    const worker = new Worker(readCapsule(capsulePath));
    process.env.PI_CODING_AGENT_DIR = worker.capsule.agentDir;
    // The parent holds stdin open for the whole run: EOF means it died (even by SIGKILL).
    process.stdin.on("end", () => void worker.interrupt());
    process.stdin.on("error", () => void worker.interrupt());
    process.stdin.resume();
    process.once("SIGINT", () => void worker.interrupt());
    process.once("SIGTERM", () => void worker.interrupt());
    try {
        await worker.run();
    }
    catch (error) {
        worker.emit({ type: "result", ok: false, error: errorText(error), ...(worker.spent === undefined ? {} : { usage: worker.spent }) });
        process.exitCode = worker.interrupted ? 143 : 1;
    }
    finally {
        worker.channel.release();
        process.stdin.unref();
        setTimeout(() => process.exit(), EXIT_SAFETY_MS).unref();
    }
}
await main();
//# sourceMappingURL=pi-worker.js.map