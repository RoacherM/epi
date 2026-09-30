// Terminal-free construction of the Pi session for MMP's own interactive host. Everything that
// decides what the model sees lives here, so it can be tested without a terminal.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  parseArgs,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { MmpArgumentError } from "../errors.js";
import { importFromPi } from "./pi-tui.js";
import { crossProjectRefusal, type ProjectIdentity } from "./project-guard.js";

export interface MmpSessionOptions {
  cwd: string;
  agentDir: string;
  /** Arguments MMP passes through to Pi (model, thinking, session flags). */
  piArgs: readonly string[];
  extensionFactories: InlineExtension[];
  externalExtensionPaths: string[];
  /** The project this process assembled its manifest from; --session/--fork targets from another
   * project are refused up front, the same way a later /resume would be (project-guard.ts). */
  projectIdentity: ProjectIdentity;
}

type ParsedPiArgs = ReturnType<typeof parseArgs>;
type Diagnostic = { type: "error" | "warning" | "info"; message: string };

interface UndiciModule {
  EnvHttpProxyAgent: new (options: Record<string, unknown>) => unknown;
  setGlobalDispatcher(dispatcher: unknown): void;
  install?: () => void;
}

/** Mirrors Pi's configureHttpDispatcher: settings proxy, idle timeout, no HTTP/2. Not exported by Pi.
 * Runs at startup and again from the TUI's applyRuntimeSettings (rebind, /reload, /settings), like Pi. */
export async function configureHttp(settingsManager: SettingsManager): Promise<void> {
  const proxy = settingsManager.getGlobalSettings().httpProxy?.trim();
  if (proxy) {
    process.env.HTTP_PROXY ??= proxy;
    process.env.HTTPS_PROXY ??= proxy;
  }
  const timeoutMs = settingsManager.getHttpIdleTimeoutMs();
  const undici = await importFromPi<UndiciModule>("undici");
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
    allowH2: false,
    proxyTunnel: true,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  }));
  undici.install?.();
}

function createSettingsManager(cwd: string, agentDir: string): SettingsManager {
  // Project .pi/settings.json is Pi's config, never MMP's (docs/decisions.md C1).
  return SettingsManager.create(cwd, agentDir, { projectTrusted: false });
}

/**
 * Mirrors the tilde-expansion half of Pi's own `normalizePath` (utils/paths.js, not exported by
 * the SDK): `~` and `~/...` only. SessionManager's own statics already call the real
 * `normalizePath` on whatever sessionDir they're given, so this only has to get `~` out of the way
 * before MMP's own pre-SessionManager code (resolveSessionArg, below) touches the same string.
 */
function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/**
 * Which Pi CLI arguments MMP's TUI host understands, in one place, so it's easy to see what's
 * missing. `isInteractivePiRun` (../interactive.ts) already keeps `--print`/`-p`, `--mode`,
 * `--help`/`-h`, `--list-models` and `--export` off this path entirely (those go through piMain's
 * print/non-interactive modes instead of reaching here). Resource flags (`--extension`,
 * `--skill`, `--theme`, `--system-prompt`, ...) are rejected even earlier, in parseMmpArgs
 * (../args.ts), before Pi's own parser ever sees them.
 *
 * Supported here (mirrors Pi's own handling in dist/main.js and dist/cli/args.js):
 *   --provider, --model, --thinking, --continue/-c, --session, --session-id, --session-dir,
 *   --no-session, --fork, --name/-n, --models, --tools/-t, --exclude-tools/-xt, --no-tools/-nt,
 *   --no-builtin-tools/-nbt, --api-key, --offline, --resume (opens the same session selector
 *   `/resume` uses, once the TUI has started; see start.ts's `startupOptionsFromPiArgs` and
 *   session-commands.ts's `runResume`), and positional messages (sent as the first prompt once
 *   the TUI is up). `--verbose` and `@file` arguments are also supported, but not parsed here:
 *   `--verbose` is read by `createMmpRuntimeExtension` (../extensions/runtime.ts), which shows
 *   startup details as transcript notices on `session_start`; `@file` text is inlined into the
 *   first message by start.ts's `startupOptionsFromPiArgs` (../file-arguments.ts) before it ever
 *   reaches `createMmpRuntime`.
 *
 * Anything else Pi's parser can set is unsupported: this throws before the TUI starts rather
 * than silently dropping it.
 */
const UNSUPPORTED_PI_ARGS: ReadonlyArray<{ present: (parsed: ParsedPiArgs) => boolean; flag: string; reason: string }> = [
  { present: (parsed) => parsed.useTheme !== undefined, flag: "--use-theme", reason: "MMP has its own theme" },
  { present: (parsed) => parsed.tuiMode !== undefined, flag: "--tui-mode", reason: "MMP's TUI is fullscreen only" },
];

function unsupportedFlagError(flag: string, reason: string): MmpArgumentError {
  return new MmpArgumentError(`${flag} is not supported by MMP: ${reason}.`);
}

function validateSupportedPiArgs(parsed: ParsedPiArgs): void {
  const fatal = parsed.diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (fatal !== undefined) {
    throw new MmpArgumentError(fatal.message);
  }
  for (const { present, flag, reason } of UNSUPPORTED_PI_ARGS) {
    if (present(parsed)) {
      throw unsupportedFlagError(flag, reason);
    }
  }
}

/** Mirrors Pi's validateForkFlags/validateSessionIdFlags (main.js): reject flag combinations that
 * would otherwise have one silently win over the other. */
function validateSessionFlagCombinations(parsed: ParsedPiArgs): void {
  if (parsed.fork !== undefined) {
    const conflicts = [
      parsed.session !== undefined ? "--session" : undefined,
      parsed.continue === true ? "--continue" : undefined,
      parsed.resume === true ? "--resume" : undefined,
      parsed.noSession === true ? "--no-session" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    if (conflicts.length > 0) {
      throw new MmpArgumentError(`--fork cannot be combined with ${conflicts.join(", ")}`);
    }
  }
  if (parsed.sessionId !== undefined) {
    const conflicts = [
      parsed.session !== undefined ? "--session" : undefined,
      parsed.continue === true ? "--continue" : undefined,
      parsed.resume === true ? "--resume" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    if (conflicts.length > 0) {
      throw new MmpArgumentError(`--session-id cannot be combined with ${conflicts.join(", ")}`);
    }
  }
}

type SessionArgResolution =
  | { type: "path" | "local"; path: string }
  | { type: "global"; path: string; cwd: string }
  | { type: "not_found" };

/** Mirrors Pi's resolveSessionPath (main.js, not exported) with the exported SessionManager
 * statics: a literal-looking path is used as-is, otherwise it's matched as a session id prefix,
 * first against this cwd's sessions, then across every project. */
async function resolveSessionArg(
  argument: string,
  cwd: string,
  sessionDir: string | undefined,
): Promise<SessionArgResolution> {
  if (argument.includes("/") || argument.includes("\\") || argument.endsWith(".jsonl")) {
    return { type: "path", path: resolvePath(cwd, argument) };
  }
  const exact = SessionManager.findById(cwd, argument, sessionDir);
  if (exact !== undefined) {
    return { type: "local", path: exact };
  }
  const local = await SessionManager.list(cwd, sessionDir);
  const localMatch = local.find((session) => session.id.startsWith(argument));
  if (localMatch !== undefined) {
    return { type: "local", path: localMatch.path };
  }
  const all = await SessionManager.listAll(sessionDir);
  const globalMatch = all.find((session) => session.id === argument) ??
    all.find((session) => session.id.startsWith(argument));
  if (globalMatch !== undefined) {
    return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
  }
  return { type: "not_found" };
}

/** Mirrors Pi's createSessionManager (main.js), using only SessionManager's exported statics. */
async function buildSessionManager(
  parsed: ParsedPiArgs,
  cwd: string,
  sessionDir: string | undefined,
  projectIdentity: ProjectIdentity,
): Promise<SessionManager> {
  if (parsed.noSession) {
    return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
  }
  if (parsed.fork !== undefined) {
    // Mirrors Pi's own createSessionManager check (main.js ~289-294): --fork --session-id <id> that
    // already names a local session would otherwise silently fork over/alongside it.
    if (parsed.sessionId !== undefined && SessionManager.findById(cwd, parsed.sessionId, sessionDir) !== undefined) {
      throw new MmpArgumentError(`Session already exists with id '${parsed.sessionId}'`);
    }
    const resolved = await resolveSessionArg(parsed.fork, cwd, sessionDir);
    if (resolved.type === "not_found") {
      throw new MmpArgumentError(`No session found matching '${parsed.fork}'`);
    }
    // --fork always lands in this cwd's project (forkFrom's targetCwd, below), regardless of which
    // project the source session came from, so it needs no project-identity check.
    return SessionManager.forkFrom(
      resolved.path,
      cwd,
      sessionDir,
      parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined,
    );
  }
  if (parsed.session !== undefined) {
    const resolved = await resolveSessionArg(parsed.session, cwd, sessionDir);
    if (resolved.type === "not_found") {
      throw new MmpArgumentError(`No session found matching '${parsed.session}'`);
    }
    // Unlike /resume mid-run, there's no current session to protect here, but a --session target
    // from another project would still leave this process's Rules mismatched to its cwd -- same
    // check /resume uses, applied whether the target came from a fuzzy id match or a literal path.
    const refusal = crossProjectRefusal(resolved.path, projectIdentity);
    if (refusal !== undefined) {
      // Pi's own CLI offers to fork a cross-project match in interactively (promptConfirm); v2 has
      // no prompt this early, so it names the flag that does the same thing without one.
      throw new MmpArgumentError(`${refusal}\nOr use --fork ${parsed.session} to copy it into this project.`);
    }
    return SessionManager.open(resolved.path, sessionDir);
  }
  if (parsed.continue === true) {
    return SessionManager.continueRecent(cwd, sessionDir);
  }
  if (parsed.sessionId !== undefined) {
    const existing = SessionManager.findById(cwd, parsed.sessionId, sessionDir);
    if (existing !== undefined) {
      return SessionManager.open(existing, sessionDir);
    }
    process.stderr.write(
      `mmp: no project session found with id '${parsed.sessionId}'; creating a new session with that id.\n`,
    );
  }
  return SessionManager.create(cwd, sessionDir, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
}

export async function createMmpRuntime(options: MmpSessionOptions): Promise<AgentSessionRuntime> {
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  const parsed = parseArgs([...options.piArgs]);
  validateSupportedPiArgs(parsed);
  validateSessionFlagCombinations(parsed);
  // Non-fatal parse diagnostics (e.g. an invalid --thinking level falls back to the default
  // instead of erroring); Pi's own CLI prints these too instead of dropping them.
  for (const diagnostic of parsed.diagnostics) {
    process.stderr.write(`mmp: ${diagnostic.message}\n`);
  }
  // Mirrors main.js's own `--offline` handling (Pi's `offline` flag only takes effect via piMain,
  // which the TUI v2 path never calls).
  if (parsed.offline) {
    process.env.PI_OFFLINE = "1";
  }
  if (parsed.name !== undefined && parsed.name.trim() === "") {
    throw new MmpArgumentError("--name requires a non-empty value");
  }
  const startupSettingsManager = createSettingsManager(options.cwd, options.agentDir);
  await configureHttp(startupSettingsManager);

  const noTools: "all" | "builtin" | undefined = parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined;

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: createSettingsManager(cwd, agentDir),
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      extensionFlagValues: parsed.unknownFlags,
      resourceLoaderOptions: {
        // Same isolation as BASE_PI_RESOURCE_ARGS on the piMain path.
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "",
        appendSystemPrompt: [""],
        additionalExtensionPaths: options.externalExtensionPaths,
        extensionFactories: options.extensionFactories,
      },
    });
    // Registering an extension's native provider starts an un-awaited auth refresh inside Pi. If it
    // queues after createAgentSessionServices' own awaited refresh, that awaited pass is discarded and
    // the initial model is picked from a stale snapshot. A refresh started now is the latest one.
    await services.modelRuntime.refresh({ allowNetwork: false });
    const diagnostics: Diagnostic[] = [...services.diagnostics];

    const cli = parsed.provider || parsed.model || parsed.thinking
      ? resolveCliModel({
          ...(parsed.provider === undefined ? {} : { cliProvider: parsed.provider }),
          ...(parsed.model === undefined ? {} : { cliModel: parsed.model }),
          ...(parsed.thinking === undefined ? {} : { cliThinking: parsed.thinking }),
          modelRuntime: services.modelRuntime,
        })
      : undefined;
    if (cli?.warning !== undefined) diagnostics.push({ type: "warning", message: cli.warning });
    if (cli?.error !== undefined) diagnostics.push({ type: "error", message: cli.error });

    // Without --models, scope to the enabled-models setting, like main.js's own modelPatterns
    // (~641: `parsed.models ?? settingsManager.getEnabledModels()`).
    const modelPatterns = parsed.models ?? services.settingsManager.getEnabledModels();
    let scopedModels: Awaited<ReturnType<typeof resolveModelScopeWithDiagnostics>>["scopedModels"] = [];
    if (modelPatterns !== undefined && modelPatterns.length > 0) {
      const scoped = await resolveModelScopeWithDiagnostics(modelPatterns, services.modelRuntime, {
        signal: AbortSignal.timeout(15_000),
      });
      scopedModels = scoped.scopedModels;
      diagnostics.push(...scoped.diagnostics);
    }

    let initialModel = cli?.model;
    let initialThinking = cli?.thinkingLevel;
    const hasHistory = sessionManager.buildSessionContext().messages.length > 0;
    if (initialModel === undefined && scopedModels.length > 0 && !hasHistory) {
      // Pi's buildSessionOptions (main.js ~382-401): prefer the saved default model when it's in
      // scope, otherwise fall back to the first scoped model. `modelsAreEqual` isn't part of the
      // SDK's export surface, so provider+id is compared directly instead.
      const savedProvider = services.settingsManager.getDefaultProvider();
      const savedModelId = services.settingsManager.getDefaultModel();
      const savedModel = savedProvider !== undefined && savedModelId !== undefined
        ? services.modelRuntime.getModel(savedProvider, savedModelId)
        : undefined;
      const savedInScope = savedModel === undefined
        ? undefined
        : scopedModels.find((scopedModel) => scopedModel.model.provider === savedModel.provider && scopedModel.model.id === savedModel.id);
      const picked = savedInScope ?? scopedModels[0]!;
      initialModel = picked.model;
      initialThinking ??= picked.thinkingLevel;
    }
    if (parsed.thinking !== undefined) {
      initialThinking = parsed.thinking;
    }
    // Whether a CLI-originated thinking level (an explicit --thinking, or a --model
    // pattern:thinking shorthand) needs re-applying once the session has a real model attached
    // (main.js ~667's cliThinkingOverride/cliThinkingFromModel).
    const cliThinkingOverride = parsed.thinking !== undefined || cli?.thinkingLevel !== undefined;

    if (parsed.apiKey !== undefined) {
      if (initialModel === undefined) {
        diagnostics.push({
          type: "error",
          message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
        });
      } else {
        await services.modelRuntime.setRuntimeApiKey(initialModel.provider, parsed.apiKey);
      }
    }

    // Warnings/info used to go straight to stderr here, which runs on every /new and /resume, not
    // just startup -- after the TUI's alt screen is up, that writes raw over the fullscreen UI. Pi
    // shows startup diagnostics in the transcript instead (interactive-mode.js ~817); MMP's `bind()`
    // does the same with `runtime.diagnostics`, so nothing is dropped, it just isn't printed here.
    const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
    }

    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      ...(initialModel === undefined ? {} : { model: initialModel }),
      ...(initialThinking === undefined ? {} : { thinkingLevel: initialThinking }),
      ...(scopedModels.length > 0 ? { scopedModels } : {}),
      ...(parsed.tools === undefined ? {} : { tools: [...parsed.tools] }),
      ...(parsed.excludeTools === undefined ? {} : { excludeTools: [...parsed.excludeTools] }),
      ...(noTools === undefined ? {} : { noTools }),
    });
    // Re-apply a CLI-originated thinking level once the session has a real model (main.js ~670-673).
    // Note: createAgentSession (sdk.js) already clamps thinkingLevel to the model's supported levels
    // using the same clampThinkingLevel as setThinkingLevel, so this rarely changes the effective
    // level; it mirrors Pi's own call site anyway, for whatever persistence/event-emission edge case
    // (a scoped model's or extension's thinking-level metadata resolving differently at this later
    // point) motivated Pi to add it.
    if (created.session.model !== undefined && cliThinkingOverride) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }
    return { ...created, services, diagnostics };
  };

  // Pi's own resolution order (main.js ~536-539): --session-dir, then its ENV_SESSION_DIR
  // (PI_CODING_AGENT_SESSION_DIR), then the sessionDir setting. MMP never reads Pi's variable here --
  // a Pi user's own PI_CODING_AGENT_SESSION_DIR must not silently redirect MMP's sessions (no shared
  // config, docs/cli-design.md §2) -- so this is MMP_SESSION_DIR instead, same semantics. `~` is
  // expanded here; SessionManager's own statics expand it again (harmless) for whatever they resolve
  // without going through this function.
  const envSessionDir = process.env.MMP_SESSION_DIR;
  const sessionDir = (parsed.sessionDir !== undefined ? expandTilde(parsed.sessionDir) : undefined) ??
    (envSessionDir !== undefined && envSessionDir !== "" ? expandTilde(envSessionDir) : undefined) ??
    startupSettingsManager.getSessionDir();
  const sessionManager = await buildSessionManager(parsed, options.cwd, sessionDir, options.projectIdentity);
  if (parsed.name !== undefined) {
    sessionManager.appendSessionInfo(parsed.name.trim());
  }
  // Pi prompts to continue in the launch cwd when a stored session's cwd is missing (main.js
  // ~541-554's getMissingSessionCwdIssue/promptForMissingSessionCwd), before the TUI exists to
  // prompt in. MMP fails fast here instead, pre-TUI, naming the fix Pi's own prompt offers.
  const sessionCwd = sessionManager.getCwd();
  if (sessionManager.getSessionFile() !== undefined && !existsSync(sessionCwd)) {
    throw new MmpArgumentError(
      `Session working directory does not exist: ${sessionCwd}\n` +
      `Current working directory: ${options.cwd}\n` +
      `Use --fork instead of --session/--continue/--session-id to copy it into the current directory.`,
    );
  }
  return createAgentSessionRuntime(createRuntime, {
    // Pi's main.js (~682): the runtime's cwd is the session's cwd, not the launch cwd -- otherwise
    // a --session target in a subfolder builds tools/system prompt for the launch cwd while the
    // header and !pwd (which read session.sessionManager.getCwd()) show the session's own cwd.
    cwd: sessionCwd,
    agentDir: options.agentDir,
    sessionManager,
  });
}
