#!/usr/bin/env node

// First, like src/cli.ts: clears the operator's PI_* before Pi's modules load (config.js reads
// PI_PACKAGE_DIR at import time, which would change PI_VERSION below; docs/cli-design.md §2.1).
import "../dist/isolate-pi-env.js";

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { BASE_PI_RESOURCE_ARGS } from "../dist/host.js";
import { canonicalize, normalizeSnapshot } from "./normalize-snapshot.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultEpiEntry = join(root, "dist", "cli.js");
const defaultPiEntry = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const PACKAGE_JSON = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const EPI_VERSION = PACKAGE_JSON.version;
// package.json's dependency entry is the single source of truth for the pinned Pi version
// (docs/pi-upgrade-design.md 4): this catches a node_modules install that drifted from it.
const EXPECTED_PI_VERSION = PACKAGE_JSON.dependencies["@earendil-works/pi-coding-agent"];
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 2000;
const EXIT_CODE = {
  success: 0,
  harness: 2,
  infra: 3,
  model: 4,
  grader: 5,
};
const VARIANTS = new Set([
  "pi-baseline",
  "epi-core-empty",
  "epi-rules-skills",
  "epi-full",
]);

const help = `Epi benchmark adapter

Usage:
  node scripts/benchmark-adapter.mjs \\
    --variant <name> \\
    --bundle <EPI_HOME template> \\
    --output-dir <new directory> \\
    --cwd <workspace> \\
    --model <provider/model> \\
    --thinking <level> \\
    --tools <comma-list> \\
    (--prompt <text> | --prompt-file <path>)

Options:
  --timeout-ms <ms>          Agent timeout (default: 600000)
  --entry <path>             Override the harness entry (test/container use)
  --grader <executable>      Optional direct grader executable
  --grader-arg <argument>    Repeatable grader argv value
  --grader-timeout-ms <ms>   Grader timeout (default: agent timeout)
  --help                     Show this help

Exit codes:
  0 success, 2 Harness/config, 3 infra/timeout, 4 model, 5 grader
`;

function argumentError(message) {
  const error = new Error(message);
  error.exitCode = EXIT_CODE.harness;
  return error;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw argumentError(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    timeoutMs: 600_000,
    graderArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const valueFlags = new Set([
      "--variant",
      "--bundle",
      "--output-dir",
      "--cwd",
      "--model",
      "--thinking",
      "--tools",
      "--prompt",
      "--prompt-file",
      "--timeout-ms",
      "--entry",
      "--grader",
      "--grader-arg",
      "--grader-timeout-ms",
    ]);
    if (!valueFlags.has(argument)) {
      throw argumentError(`unknown argument ${JSON.stringify(argument)}`);
    }
    const value = requireValue(argv, index, argument);
    index += 1;
    switch (argument) {
      case "--variant":
        options.variant = value;
        break;
      case "--bundle":
        options.bundle = value;
        break;
      case "--output-dir":
        options.outputDir = value;
        break;
      case "--cwd":
        options.cwd = value;
        break;
      case "--model":
        options.model = value;
        break;
      case "--thinking":
        options.thinking = value;
        break;
      case "--tools":
        options.tools = value;
        break;
      case "--prompt":
        options.prompt = value;
        break;
      case "--prompt-file":
        options.promptFile = value;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value);
        break;
      case "--entry":
        options.entry = value;
        break;
      case "--grader":
        options.grader = value;
        break;
      case "--grader-arg":
        options.graderArgs.push(value);
        break;
      case "--grader-timeout-ms":
        options.graderTimeoutMs = Number(value);
        break;
    }
  }
  return options;
}

function requirePathType(path, expected, label) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw argumentError(`${label} does not exist: ${path}`);
  }
  if ((expected === "file" && !stats.isFile()) || (expected === "directory" && !stats.isDirectory())) {
    throw argumentError(`${label} must be a ${expected}: ${path}`);
  }
}

function resolveOptions(raw) {
  if (raw.help === true) {
    return { help: true };
  }
  for (const field of [
    "variant",
    "bundle",
    "outputDir",
    "cwd",
    "model",
    "thinking",
    "tools",
  ]) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      throw argumentError(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    }
  }
  if (!VARIANTS.has(raw.variant)) {
    throw argumentError(`unsupported variant ${JSON.stringify(raw.variant)}`);
  }
  if (!raw.model.includes("/")) {
    throw argumentError("--model must be provider-qualified (provider/model)");
  }
  if ((raw.prompt === undefined) === (raw.promptFile === undefined)) {
    throw argumentError("define exactly one of --prompt or --prompt-file");
  }
  if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
    throw argumentError("--timeout-ms must be a positive integer");
  }
  const graderTimeoutMs = raw.graderTimeoutMs ?? raw.timeoutMs;
  if (!Number.isInteger(graderTimeoutMs) || graderTimeoutMs <= 0) {
    throw argumentError("--grader-timeout-ms must be a positive integer");
  }

  const bundle = resolve(raw.bundle);
  const outputDir = resolve(raw.outputDir);
  const cwd = resolve(raw.cwd);
  const promptFile = raw.promptFile === undefined ? undefined : resolve(raw.promptFile);
  const entry = resolve(
    raw.entry ?? (raw.variant === "pi-baseline" ? defaultPiEntry : defaultEpiEntry),
  );
  requirePathType(bundle, "directory", "--bundle");
  requirePathType(cwd, "directory", "--cwd");
  requirePathType(entry, "file", "harness entry");
  if (promptFile !== undefined) {
    requirePathType(promptFile, "file", "--prompt-file");
  }
  let grader = raw.grader;
  if (
    grader !== undefined &&
    (isAbsolute(grader) || grader.includes("/") || grader.includes("\\"))
  ) {
    grader = resolve(grader);
    requirePathType(grader, "file", "--grader");
    grader = realpathSync(grader);
  }
  const relativeOutput = relative(bundle, outputDir);
  if (relativeOutput === "" || (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== "..")) {
    throw argumentError("--output-dir must not be inside --bundle");
  }
  return {
    ...raw,
    help: false,
    bundle: realpathSync(bundle),
    outputDir,
    cwd: realpathSync(cwd),
    entry: realpathSync(entry),
    prompt: raw.prompt ?? readFileSync(promptFile, "utf8"),
    promptFile,
    grader,
    graderTimeoutMs,
    harness: raw.variant === "pi-baseline" ? "pi" : "epi",
  };
}

function sensitiveBundlePath(source, bundle) {
  const rel = relative(bundle, source);
  if (rel === "") {
    return false;
  }
  const parts = rel.split(sep);
  if (parts.includes(".DS_Store") || parts.some((part) => part === ".env" || part.startsWith(".env."))) {
    return true;
  }
  const normalized = parts.join("/");
  return normalized === "pi/auth.json" ||
    normalized === "pi/trust.json" ||
    normalized.startsWith("pi/sessions/") ||
    normalized === "runtime" ||
    normalized.startsWith("runtime/") ||
    normalized === "artifacts" ||
    normalized.startsWith("artifacts/");
}

function copyBundle(bundle, trialHome, harness) {
  cpSync(bundle, trialHome, {
    recursive: true,
    filter: (source) => {
      const rel = relative(bundle, source);
      if (
        harness === "pi" &&
        rel !== "" &&
        rel !== "pi" &&
        !rel.startsWith(`pi${sep}`)
      ) {
        return false;
      }
      return !sensitiveBundlePath(source, bundle);
    },
  });
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bundleFingerprints(bundle) {
  const files = [];
  const visit = (path) => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      files.push({
        path: relative(bundle, path).split(sep).join("/"),
        type: "symlink",
        sha256: hashBytes(realpathSync(path)),
      });
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry));
      }
      return;
    }
    if (stats.isFile()) {
      files.push({
        path: relative(bundle, path).split(sep).join("/"),
        type: "file",
        sha256: hashBytes(readFileSync(path)),
      });
    }
  };
  visit(bundle);
  return files;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function terminateProcess(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child handle.
    }
  }
  child.kill(signal);
}

async function runChild({
  command = process.execPath,
  entry,
  args,
  cwd,
  env,
  timeoutMs,
  stdoutPath,
  stderrPath,
  parseJsonl = false,
  onEvent,
  interruptSignal,
}) {
  const stdoutFile = createWriteStream(stdoutPath, { flags: "w" });
  const stderrFile = createWriteStream(stderrPath, { flags: "w" });
  const child = spawn(command, entry === undefined ? args : [entry, ...args], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let invalidJsonLine;
  let timedOut = false;
  let interrupted = false;
  let spawnError;
  let killTimer;

  const terminate = () => {
    terminateProcess(child, "SIGTERM");
    killTimer ??= setTimeout(() => terminateProcess(child, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };
  const onInterrupt = () => {
    interrupted = true;
    terminate();
  };
  interruptSignal?.addEventListener("abort", onInterrupt, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timeout.unref();

  const consumeLines = () => {
    while (true) {
      const newline = lineBuffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!parseJsonl || line.length === 0 || invalidJsonLine !== undefined) {
        continue;
      }
      if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) {
        invalidJsonLine = "JSONL record exceeds 16 MiB";
        continue;
      }
      try {
        const event = JSON.parse(line);
        if (typeof event !== "object" || event === null || Array.isArray(event)) {
          invalidJsonLine = "JSONL record is not an object";
        } else {
          onEvent?.(event);
        }
      } catch (error) {
        invalidJsonLine = error instanceof Error ? error.message : String(error);
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    const buffer = Buffer.from(chunk);
    if (!stdoutFile.write(buffer)) {
      child.stdout.pause();
      stdoutFile.once("drain", () => child.stdout.resume());
    }
    const decoded = stdoutDecoder.write(buffer);
    if (stdout.length < MAX_CAPTURE_BYTES) {
      stdout += decoded.slice(0, MAX_CAPTURE_BYTES - stdout.length);
    }
    if (parseJsonl && invalidJsonLine === undefined) {
      lineBuffer += decoded;
      if (Buffer.byteLength(lineBuffer) > MAX_JSONL_LINE_BYTES && !lineBuffer.includes("\n")) {
        invalidJsonLine = "JSONL record exceeds 16 MiB";
        lineBuffer = "";
      } else {
        consumeLines();
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    const buffer = Buffer.from(chunk);
    if (!stderrFile.write(buffer)) {
      child.stderr.pause();
      stderrFile.once("drain", () => child.stderr.resume());
    }
    const decoded = stderrDecoder.write(buffer);
    if (stderr.length < MAX_CAPTURE_BYTES) {
      stderr += decoded.slice(0, MAX_CAPTURE_BYTES - stderr.length);
    }
  });

  const closed = Promise.withResolvers();
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", (code, signal) => closed.resolve({ code, signal }));
  const exit = await closed.promise;
  clearTimeout(timeout);
  if (killTimer !== undefined) {
    clearTimeout(killTimer);
  }
  interruptSignal?.removeEventListener("abort", onInterrupt);
  const stdoutTail = stdoutDecoder.end();
  const stderrTail = stderrDecoder.end();
  stdout += stdoutTail.slice(0, Math.max(0, MAX_CAPTURE_BYTES - stdout.length));
  stderr += stderrTail.slice(0, Math.max(0, MAX_CAPTURE_BYTES - stderr.length));
  if (parseJsonl && invalidJsonLine === undefined) {
    lineBuffer += stdoutTail;
    consumeLines();
  }
  if (parseJsonl && lineBuffer.length > 0) {
    invalidJsonLine ??= "stdout ended with a partial JSONL record";
  }
  stdoutFile.end();
  stderrFile.end();
  await Promise.all([finished(stdoutFile), finished(stderrFile)]);
  return {
    ...exit,
    stdout,
    stderr,
    invalidJsonLine,
    timedOut,
    interrupted,
    spawnError,
  };
}

function createMetricsCollector() {
  const metrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    toolCalls: 0,
    toolErrors: 0,
    compactions: 0,
  };
  const state = {
    metrics,
    eventCount: 0,
    agentSettled: false,
    modelErrors: [],
    extensionErrors: [],
    resolvedModels: new Set(),
  };
  const addUsage = (usage) => {
    if (usage === undefined || usage === null) {
      return;
    }
    metrics.inputTokens += Number(usage.input ?? 0);
    metrics.outputTokens += Number(usage.output ?? 0);
    metrics.cacheReadTokens += Number(usage.cacheRead ?? 0);
    metrics.cacheWriteTokens += Number(usage.cacheWrite ?? 0);
    metrics.reasoningTokens += Number(usage.reasoning ?? 0);
    metrics.cost += Number(usage.cost?.total ?? 0);
  };
  return {
    state,
    accept(event) {
      state.eventCount += 1;
      if (event.type === "agent_settled") {
        state.agentSettled = true;
      }
      if (event.type === "tool_execution_start") {
        metrics.toolCalls += 1;
      }
      if (event.type === "tool_execution_end" && event.isError === true) {
        metrics.toolErrors += 1;
      }
      if (event.type === "extension_error") {
        state.extensionErrors.push(String(event.error ?? event.message ?? "extension error"));
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        addUsage(event.message.usage);
        if (typeof event.message.provider === "string" && typeof event.message.model === "string") {
          state.resolvedModels.add(`${event.message.provider}/${event.message.model}`);
        }
        if (event.message.stopReason === "error") {
          state.modelErrors.push(String(event.message.errorMessage ?? "model error"));
        }
      }
      if (event.type === "compaction_end" && event.aborted !== true) {
        metrics.compactions += 1;
        addUsage(event.result?.usage);
        if (event.errorMessage !== undefined) {
          state.modelErrors.push(String(event.errorMessage));
        }
      }
    },
  };
}

function baselineAssembly(trialHome, cwd) {
  return {
    epiVersion: EPI_VERSION,
    piVersion: PI_VERSION,
    harness: "pi",
    epiHome: trialHome,
    agentDir: join(trialHome, "pi"),
    projectDiscovery: "disabled",
    cwd,
    piResourceArgs: [...BASE_PI_RESOURCE_ARGS],
    rules: [],
    skills: [],
    inlineExtensions: [],
    externalExtensions: [],
  };
}

function listRelativeFiles(path, rootPath = path) {
  if (!existsSync(path)) {
    return [];
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return [relative(rootPath, path).split(sep).join("/") || "."];
  }
  return readdirSync(path)
    .sort()
    .flatMap((entry) => listRelativeFiles(join(path, entry), rootPath));
}

function scanOrphans(trialHome) {
  if (process.platform === "win32") {
    return { status: "unavailable", pids: [] };
  }
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) {
    return { status: "unavailable", pids: [] };
  }
  const pids = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(trialHome))
    .map((line) => Number(/^\d+/.exec(line)?.[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return { status: "checked", pids };
}

function classifyRun(run, collector) {
  if (run.spawnError !== undefined || run.timedOut || run.interrupted || run.signal !== null) {
    return "infra";
  }
  // `epi --mode json` exits 1 after a failed request (docs/cli-design.md); Pi exits 0.
  const modelFailed = collector.modelErrors.length > 0;
  if (
    (run.code !== 0 && !(run.code === 1 && modelFailed)) ||
    run.invalidJsonLine !== undefined ||
    collector.extensionErrors.length > 0 ||
    !collector.agentSettled
  ) {
    return "harness";
  }
  if (modelFailed) {
    return "model";
  }
  return null;
}

async function main(argv) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    process.stdout.write(help);
    return EXIT_CODE.success;
  }
  if (PI_VERSION !== EXPECTED_PI_VERSION) {
    throw argumentError(
      `benchmark requires Pi ${EXPECTED_PI_VERSION}, loaded ${PI_VERSION}`,
    );
  }
  if (existsSync(options.outputDir)) {
    if (!statSync(options.outputDir).isDirectory() || readdirSync(options.outputDir).length > 0) {
      throw argumentError("--output-dir must be absent or empty");
    }
  } else {
    mkdirSync(options.outputDir, { recursive: true });
  }
  const trialHome = join(options.outputDir, "epi-home");
  copyBundle(options.bundle, trialHome, options.harness);
  const requestPath = join(options.outputDir, "request.json");
  const assemblyPath = join(options.outputDir, "assembly.json");
  const fingerprintPath = join(options.outputDir, "assembly-fingerprint.json");
  const eventsPath = join(options.outputDir, "events.jsonl");
  const stderrPath = join(options.outputDir, "stderr.log");
  const metadataPath = join(options.outputDir, "metadata.json");
  const preflightStdoutPath = join(options.outputDir, "preflight.stdout");
  const preflightStderrPath = join(options.outputDir, "preflight.stderr");
  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const trialId = randomUUID();
  writeJson(requestPath, {
    schemaVersion: 1,
    trialId,
    variant: options.variant,
    harness: options.harness,
    prompt: options.prompt,
    cwd: options.cwd,
    model: options.model,
    thinking: options.thinking,
    tools: options.tools.split(",").map((tool) => tool.trim()).filter(Boolean),
    timeoutMs: options.timeoutMs,
  });

  const interruptController = new AbortController();
  const interrupt = (signal) => interruptController.abort(signal);
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  // Both harnesses get this script's env as-is, after the bridge above: the operator's own PI_*
  // are gone, EPI_* knobs (EPI_OFFLINE, ...) arrive as PI_*, everything else passes through. Bare
  // `pi` gets no further isolation: this is a dev tool the operator runs, not something users do.
  const environment = {
    ...process.env,
    // HOME isolation matters beyond auth/session state now: Epi auto-discovers skills from
    // ~/.agents/skills (docs/decisions.md S1), so a real HOME would leak the operator's own
    // skills into every trial, breaking "capability tier is decided by the bundle alone" for
    // epi-core-empty and making assemblyDigest differ machine to machine.
    HOME: trialHome,
    EPI_HOME: trialHome,
    PI_CODING_AGENT_DIR: join(trialHome, "pi"),
  };
  let assembly;
  let preflightRun;
  let preflightError = null;
  let assemblyDeterministic = true;
  let preflightFailure = null;
  if (options.harness === "epi") {
    const preflightArgs = ["--dry-run", "--no-approve"];
    const first = preflightRun = await runChild({
      entry: options.entry,
      args: preflightArgs,
      cwd: options.cwd,
      env: environment,
      timeoutMs: 60_000,
      stdoutPath: preflightStdoutPath,
      stderrPath: preflightStderrPath,
      interruptSignal: interruptController.signal,
    });
    if (first.code !== 0 || first.spawnError !== undefined || first.timedOut || first.signal !== null) {
      preflightFailure = first.spawnError !== undefined || first.timedOut || first.signal !== null
        ? "infra"
        : "harness";
    } else {
      try {
        assembly = JSON.parse(first.stdout);
      } catch (error) {
        preflightError = error instanceof Error ? error.message : String(error);
        preflightFailure = "harness";
      }
    }
    if (preflightFailure === null) {
      const second = await runChild({
        entry: options.entry,
        args: preflightArgs,
        cwd: options.cwd,
        env: environment,
        timeoutMs: 60_000,
        stdoutPath: join(options.outputDir, "preflight-2.stdout"),
        stderrPath: join(options.outputDir, "preflight-2.stderr"),
        interruptSignal: interruptController.signal,
      });
      assemblyDeterministic = second.code === 0 && second.stdout === first.stdout;
      rmSync(join(options.outputDir, "preflight-2.stdout"), { force: true });
      rmSync(join(options.outputDir, "preflight-2.stderr"), { force: true });
      if (!assemblyDeterministic) {
        preflightFailure = "harness";
        preflightError = "two consecutive dry-run snapshots differed";
      }
    }
  } else {
    assembly = baselineAssembly(trialHome, options.cwd);
    writeFileSync(preflightStdoutPath, `${JSON.stringify(assembly, null, 2)}\n`, "utf8");
    writeFileSync(preflightStderrPath, "", "utf8");
  }

  const normalizedAssembly = assembly === undefined
    ? null
    : canonicalize(normalizeSnapshot(assembly, [
        [trialHome, "$EPI_HOME"],
        [options.cwd, "$CWD"],
      ]));
  const fingerprints = bundleFingerprints(trialHome);
  const assemblyDigest = hashBytes(JSON.stringify({ normalizedAssembly, fingerprints }));
  writeJson(assemblyPath, assembly ?? null);
  writeJson(fingerprintPath, {
    schemaVersion: 1,
    normalizedAssembly,
    files: fingerprints,
    sha256: assemblyDigest,
  });

  let run;
  const collector = createMetricsCollector();
  let failureCategory = preflightFailure;
  if (failureCategory === null) {
    const commonArgs = [
      "--mode",
      "json",
      "--no-session",
      "--no-approve",
      "--offline",
      "--model",
      options.model,
      "--thinking",
      options.thinking,
      "--tools",
      options.tools,
      "--print",
      options.prompt,
    ];
    const measuredArgs = options.harness === "epi"
      ? commonArgs
      : [...BASE_PI_RESOURCE_ARGS, ...commonArgs];
    run = await runChild({
      entry: options.entry,
      args: measuredArgs,
      cwd: options.cwd,
      env: environment,
      timeoutMs: options.timeoutMs,
      stdoutPath: eventsPath,
      stderrPath,
      parseJsonl: true,
      onEvent: (event) => collector.accept(event),
      interruptSignal: interruptController.signal,
    });
    failureCategory = classifyRun(run, collector.state);
  } else {
    writeFileSync(eventsPath, "", "utf8");
    writeFileSync(stderrPath, "", "utf8");
  }

  let graderRun;
  if (failureCategory === null && options.grader !== undefined) {
    graderRun = await runChild({
      command: options.grader,
      args: options.graderArgs,
      cwd: options.cwd,
      env: {
        ...environment,
        EPI_BENCHMARK_OUTPUT_DIR: options.outputDir,
        EPI_BENCHMARK_EVENTS: eventsPath,
        EPI_BENCHMARK_REQUEST: requestPath,
      },
      timeoutMs: options.graderTimeoutMs,
      stdoutPath: join(options.outputDir, "grader.stdout"),
      stderrPath: join(options.outputDir, "grader.stderr"),
      interruptSignal: interruptController.signal,
    });
    if (
      graderRun.code !== 0 ||
      graderRun.signal !== null ||
      graderRun.timedOut ||
      graderRun.spawnError !== undefined
    ) {
      failureCategory = "grader";
    }
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const orphanCheck = scanOrphans(trialHome);
  if (orphanCheck.pids.length > 0 && failureCategory === null) {
    failureCategory = "infra";
  }
  const isolationCheck = {
    sessionFiles: listRelativeFiles(join(trialHome, "pi", "sessions")),
    trustFilePresent: existsSync(join(trialHome, "pi", "trust.json")),
    capsuleFiles: listRelativeFiles(join(trialHome, "runtime")),
  };
  if (
    failureCategory === null &&
    (
      isolationCheck.sessionFiles.length > 0 ||
      isolationCheck.trustFilePresent ||
      isolationCheck.capsuleFiles.length > 0
    )
  ) {
    failureCategory = "infra";
  }
  if (interruptController.signal.aborted && failureCategory === null) {
    failureCategory = "infra";
  }
  const finishedAt = new Date();
  const metadata = {
    schemaVersion: 1,
    trialId,
    variant: options.variant,
    harness: options.harness,
    versions: {
      epi: EPI_VERSION,
      pi: PI_VERSION,
      node: process.version,
    },
    assemblyDigest,
    assemblyDeterministic,
    requested: {
      model: options.model,
      thinking: options.thinking,
      tools: options.tools.split(",").map((tool) => tool.trim()).filter(Boolean),
      cwd: options.cwd,
      trustMode: "no-approve",
      session: "ephemeral",
      offlineStartup: true,
    },
    resolvedModels: [...collector.state.resolvedModels].sort(),
    timing: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.round(performance.now() - startedMonotonic),
    },
    result: {
      success: failureCategory === null,
      failureCategory,
      exitCode: run?.code ?? null,
      signal: run?.signal ?? null,
      timedOut: run?.timedOut ?? false,
      interrupted: run?.interrupted ?? interruptController.signal.aborted,
      invalidJsonl: run?.invalidJsonLine ?? null,
      agentSettled: collector.state.agentSettled,
      modelErrors: collector.state.modelErrors,
      extensionErrors: collector.state.extensionErrors,
    },
    metrics: collector.state.metrics,
    preflight: {
      success: preflightFailure === null,
      failureCategory: preflightFailure,
      exitCode: preflightRun?.code ?? (options.harness === "pi" ? 0 : null),
      signal: preflightRun?.signal ?? null,
      timedOut: preflightRun?.timedOut ?? false,
      error: preflightError,
    },
    eventCount: collector.state.eventCount,
    orphanCheck,
    isolationCheck,
    grader: options.grader === undefined
      ? { status: "not-run" }
      : {
          status: graderRun?.code === 0 ? "passed" : "failed",
          exitCode: graderRun?.code ?? null,
          signal: graderRun?.signal ?? null,
          timedOut: graderRun?.timedOut ?? false,
        },
    artifacts: {
      request: "request.json",
      assembly: "assembly.json",
      assemblyFingerprint: "assembly-fingerprint.json",
      events: "events.jsonl",
      stderr: "stderr.log",
      preflightStderr: "preflight.stderr",
    },
  };
  writeJson(metadataPath, metadata);
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
  return failureCategory === null ? EXIT_CODE.success : EXIT_CODE[failureCategory];
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`epi-benchmark: ${message}\n`);
  process.exitCode = error?.exitCode ?? EXIT_CODE.infra;
}
