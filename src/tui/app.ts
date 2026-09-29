// MMP TUI v2: fullscreen grok-build layout, transcript, prompt, extension host, lifecycle.
// Layout and data flow follow docs/tui-design.md 2.2 and 4.1.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, Container, Editor, Terminal } from "@earendil-works/pi-tui";

import { runUserBash } from "./bash-block.js";
import {
  headerBar,
  PromptFrame,
  type QueuedMessagesState,
  queuedMessagesBar,
  type Shortcut,
  shortcutsBar,
  type TurnState,
  TurnStatus,
} from "./chrome.js";
import { findBuiltin, slashCompletions } from "./builtins.js";
import type { CommandHost } from "./command-host.js";
import { errorText } from "./errors.js";
import { createExtensionUIContext, type HostSurface } from "./ext-host.js";
import { installKeybindings } from "./keybindings.js";
import { createKeyActions } from "./keys.js";
import { piTui } from "./pi-tui.js";
import { crossProjectRefusal, type ProjectIdentity } from "./project-guard.js";
import { confirmMissingSessionCwd, missingSessionCwdIssue, runResume } from "./session-commands.js";
import { Transcript } from "./transcript.js";

export interface TuiAppOptions {
  runtime: AgentSessionRuntime;
  theme: Theme;
  cwd: string;
  /** MMP's Pi state directory (~/.mmp/pi): keybindings.json is read from here. */
  agentDir: string;
  logDirectory: string;
  /** The project this process assembled its manifest from; used to refuse a cross-project switch. */
  projectIdentity: ProjectIdentity;
  /** Pi CLI positional messages (docs/tui-design.md §15): sent as prompts, in order, once the app
   * is up. Mirrors Pi's own interactive mode sequencing them after startup diagnostics. */
  initialMessages?: string[];
  /** `--resume`: open the same session selector `/resume` uses, once, right after startup and
   * before any initial message, mirroring Pi's own `--resume` (start.ts's `startupOptionsFromPiArgs`). */
  resumeOnStart?: boolean;
  terminal?: Terminal;
}

// One instance per layout slot: the layout engine keys slots by component identity.
const blank = (): Component => ({ render: () => [""], invalidate() {} });

/** grok's horizontal margin: two columns on each side. */
function inset(component: Component, columns = 2): Component {
  return {
    render: (width) => component.render(Math.max(1, width - columns * 2)).map((line) => `${" ".repeat(columns)}${line}`),
    invalidate: () => component.invalidate(),
  };
}

function readGitBranch(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
    } catch {
      if (dirname(dir) === dir) return undefined;
    }
  }
}

export async function runTuiApp(options: TuiAppOptions): Promise<number> {
  const { runtime, theme, cwd } = options;
  const terminal = options.terminal ?? new piTui.ProcessTerminal();
  const keybindings = installKeybindings(options.agentDir);
  const tui = new piTui.TuiAltScreen(terminal, false, options.logDirectory, {
    scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest ")),
  });

  let session: AgentSession = runtime.session;
  const transcript = new Transcript(tui, theme, session);
  const statuses = new Map<string, string>();
  const widgets = { aboveEditor: new Map<string, Component>(), belowEditor: new Map<string, Component>() };
  let toolsExpanded = false;
  let turn: TurnState | undefined;
  let queued: QueuedMessagesState = { steering: [], followUp: [] };
  // Messages submitted while compaction is running (Pi's compactionQueuedMessages): session.prompt()
  // throws during compaction, so these are held here and sent once compaction_end fires.
  let compactionQueue: { text: string; mode: "steer" | "followUp" }[] = [];
  let workingMessage: string | undefined;
  let workingVisible = true;
  let branch = readGitBranch(cwd);
  // True while a dialog/selector (ui.select, /model, /login, …) occupies the editor slot; the app
  // key table and the shortcuts bar both read it (docs/tui-design.md 4.1: the bar follows focus).
  let editorSlotHasDialog = false;

  // ── layout (grok notes 2.2): header, transcript, turn status, prompt, shortcuts ──
  const widgetsAbove: Container = new piTui.Container();
  const editorSlot: Container = new piTui.Container();
  const widgetsBelow: Container = new piTui.Container();
  const footerSlot: Container = new piTui.Container();
  const editor: Editor = new piTui.Editor(tui, {
    borderColor: (text) => theme.fg("border", text),
    selectList: getSelectListTheme(),
  });
  const prompt = new PromptFrame(theme, editor, () => {
    const model = session.model;
    const hasModel = model !== undefined && runtime.services.modelRuntime.getAvailableSnapshot().length > 0;
    return hasModel ? `${model.name ?? model.id} (${session.thinkingLevel})` : "no model · /login";
  }, () => (text) => theme.fg(turn === undefined ? "border" : "borderAccent", text));
  editorSlot.addChild(prompt);

  const header = headerBar(theme, () => {
    const usage = session.getContextUsage();
    return {
      branch,
      cwd: session.sessionManager.getCwd(),
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: usage?.contextWindow,
    };
  });
  const turnStatus = new TurnStatus(
    theme,
    () => (turn === undefined || !workingVisible ? undefined : { ...turn, activity: workingMessage ?? turn.activity }),
    () => tui.requestRender(),
  );
  const defaultFooter = shortcutsBar(theme, () => {
    const shortcuts: Shortcut[] = editorSlotHasDialog
      ? [{ key: "↑↓", label: "select" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }]
      : turn === undefined
        ? [{ key: "Shift+Tab", label: "thinking" }, { key: "Ctrl+o", label: "tools" }, { key: "/", label: "commands" }, { key: "Ctrl+d", label: "quit" }]
        : [{ key: "Esc", label: "stop" }, { key: "Ctrl+c", label: "cancel" }, { key: "Ctrl+o", label: "tools" }, { key: "Alt+Enter", label: "steer" }];
    return { shortcuts, right: theme.fg("muted", [...statuses.values()].join(" · ")) };
  });
  footerSlot.addChild(defaultFooter);
  const queueDisplay = queuedMessagesBar(theme, () => ({
    steering: [...queued.steering, ...compactionQueue.filter((message) => message.mode === "steer").map((message) => message.text)],
    followUp: [...queued.followUp, ...compactionQueue.filter((message) => message.mode === "followUp").map((message) => message.text)],
  }));

  const scroll = new piTui.ScrollView(inset(transcript.root), { follow: "end", primary: true, scrollbar: "auto" });
  const turnGap: Component = { render: () => (turn === undefined ? [] : [""]), invalidate() {} };
  tui.setLayoutRoot(new piTui.VStack([
    { component: blank(), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(header), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: blank(), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: turnGap, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(turnStatus), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(queueDisplay), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: blank(), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(widgetsAbove), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(editorSlot), basis: "auto", grow: 0, shrink: 1, minSize: 3 },
    { component: inset(widgetsBelow), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(footerSlot), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: blank(), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
  ]));

  function rebuildWidgets(): void {
    widgetsAbove.clear();
    widgetsBelow.clear();
    for (const component of widgets.aboveEditor.values()) widgetsAbove.addChild(component);
    for (const component of widgets.belowEditor.values()) widgetsBelow.addChild(component);
  }

  /** Activity label shown on the turn status row; the phase timer restarts when it changes. */
  function setActivity(activity: string): void {
    if (turn === undefined || turn.activity === activity) return;
    turn = { ...turn, activity, phaseStartedAt: Date.now() };
    tui.requestRender();
  }

  // ── autocomplete ──────────────────────────────────────────────────────────
  let autocomplete: AutocompleteProvider = new piTui.CombinedAutocompleteProvider([], cwd, null);
  // Rebuilt in bind() (after a /new, /resume, /reload, or fork), so this always reads the cwd of
  // whichever session is bound then, not the cwd the app launched with.
  function resetAutocomplete(): void {
    autocomplete = new piTui.CombinedAutocompleteProvider(slashCompletions(session), session.sessionManager.getCwd(), null);
    editor.setAutocompleteProvider(autocomplete);
  }

  // ── extension host ────────────────────────────────────────────────────────
  const surface: HostSurface = {
    tui,
    theme,
    // `focus` lets a caller display a Container whose own keyboard handling lives on a child
    // (UserMessageSelectorComponent's handleInput is only on its inner getMessageList(), unlike
    // e.g. TreeSelectorComponent, which delegates internally) -- Pi's own showSelector supports
    // the same {component, focus} split (session-tree-commands.ts's /fork).
    takeEditorSlot(component, focus) {
      editorSlot.clear();
      editorSlot.addChild(component);
      tui.setFocus(focus ?? component);
      editorSlotHasDialog = true;
      tui.requestRender();
      return () => {
        editorSlot.clear();
        editorSlot.addChild(prompt);
        tui.setFocus(editor);
        editorSlotHasDialog = false;
        tui.requestRender();
      };
    },
    setHeader(component) {
      transcript.header.clear();
      if (component !== undefined) transcript.header.addChild(component);
      tui.requestRender();
    },
    setFooter(component) {
      footerSlot.clear();
      footerSlot.addChild(component ?? defaultFooter);
      tui.requestRender();
    },
    setWidget(key, component, placement) {
      widgets.aboveEditor.delete(key);
      widgets.belowEditor.delete(key);
      if (component !== undefined) widgets[placement].set(key, component);
      rebuildWidgets();
      tui.requestRender();
    },
    setStatus(key, text) {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      tui.requestRender();
    },
    setWorking(change) {
      if ("message" in change) workingMessage = change.message;
      if (change.visible !== undefined) workingVisible = change.visible;
      tui.requestRender();
    },
    setTitle: (title) => terminal.setTitle(title),
    getEditorText: () => editor.getText(),
    setEditorText: (text) => {
      editor.setText(text);
      tui.requestRender();
    },
    setAutocompleteProvider(provider) {
      autocomplete = provider;
      editor.setAutocompleteProvider(provider);
    },
    getAutocompleteProvider: () => autocomplete,
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(expanded) {
      toolsExpanded = expanded;
      transcript.setToolsExpanded(expanded);
      tui.requestRender();
    },
    notify: (message, tone) => transcript.notice(message, tone),
  };
  const uiContext = createExtensionUIContext(surface);
  const commandHost: CommandHost = {
    tui,
    theme,
    // A getter, not a snapshot: /trust and anything else reading commandHost.cwd must see the
    // bound session's cwd, which can change after /new, /resume, /reload, or a fork.
    get cwd() {
      return session.sessionManager.getCwd();
    },
    agentDir: options.agentDir,
    runtime,
    projectIdentity: options.projectIdentity,
    session: () => session,
    takeEditorSlot: (component, focus) => surface.takeEditorSlot(component, focus),
    notice: (text, tone) => transcript.notice(text, tone ?? "info"),
    addBlock: (component) => transcript.addBlock(component),
    getEditorText: () => editor.getText(),
    setEditorText: (text) => surface.setEditorText(text),
    getExpandedEditorText: () => editor.getExpandedText(),
    insertEditorText: (text) => {
      editor.insertTextAtCursor(text);
      tui.requestRender();
    },
    addToHistory: (text) => editor.addToHistory(text),
    submit: (text) => submit(text),
    restoreQueuedMessagesToEditor: () => restoreQueuedMessagesToEditor(),
    isWorking: () => turn !== undefined,
    toggleToolsExpanded: () => surface.setToolsExpanded(!toolsExpanded),
    exit: (code) => exit(code),
    reloadSession: () => reloadSession(),
    // navigateTree (session-tree-commands.ts's /tree) stays on the same AgentSession instance, so
    // setRebindSession never fires for it; this is the same replay bind() does after a real switch.
    resetTranscript: () => transcript.reset(session),
  };

  // ── lifecycle ─────────────────────────────────────────────────────────────
  let exiting = false;
  let resolveRun!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    resolveRun = resolve;
  });

  async function exit(code = 0): Promise<void> {
    if (exiting) return;
    exiting = true;
    turnStatus.stop();
    tui.stop();
    try {
      await runtime.dispose();
    } finally {
      resolveRun(code);
    }
  }

  const onSignal = () => void exit(0);
  const onCrash = (error: unknown) => {
    // Leave the alternate screen before the stack trace, or the user's terminal stays wrecked.
    tui.stop();
    process.stderr.write(`mmp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  // ── session-replacement guard (bugs 4, 7) ───────────────────────────────────
  // True for the duration of an actual runtime.newSession/switchSession/fork call (teardown through
  // rebind), not any UI shown around it (e.g. the missing-cwd confirm below runs before any
  // teardown, so a compaction ending naturally during it must still flush normally).
  let sessionReplacementInFlight = false;
  async function withSessionReplacement<T>(action: () => Promise<T>): Promise<T> {
    sessionReplacementInFlight = true;
    try {
      return await action();
    } finally {
      sessionReplacementInFlight = false;
    }
  }
  /** Mirrors Pi's handleFatalRuntimeError (interactive-mode.js ~1557): once a session-replacing
   * call fails after teardown started, the old session is disposed and there is nothing left to
   * continue running -- leave the alternate screen cleanly, report why, and exit. Never routes
   * through `exit()`: that calls `runtime.dispose()`, which would dispose an already-disposed
   * session. */
  function fatal(prefix: string, error: unknown): never {
    if (!exiting) {
      exiting = true;
      turnStatus.stop();
      tui.stop();
      process.stderr.write(`mmp: ${prefix}: ${errorText(error)}\n`);
    }
    process.exit(1);
  }
  // Wrapping these three in one place covers every call site that can replace the session --
  // app.ts's own commandContextActions below, MMP's /new builtin (builtins.ts calls
  // host.runtime.newSession() directly), and session-commands.ts's /resume -- without each of them
  // repeating the same failure handling.
  const originalNewSession = runtime.newSession.bind(runtime);
  const originalFork = runtime.fork.bind(runtime);
  const originalSwitchSession = runtime.switchSession.bind(runtime);
  runtime.newSession = async (newSessionOptions) => {
    try {
      return await withSessionReplacement(() => originalNewSession(newSessionOptions));
    } catch (error) {
      return fatal("Failed to create session", error);
    }
  };
  runtime.fork = async (entryId, forkOptions) => {
    try {
      return await withSessionReplacement(() => originalFork(entryId, forkOptions));
    } catch (error) {
      return fatal("Failed to fork session", error);
    }
  };
  runtime.switchSession = async (sessionPath, switchOptions) => {
    try {
      return await withSessionReplacement(() => originalSwitchSession(sessionPath, switchOptions));
    } catch (error) {
      // Thrown by assertSessionCwdExists before any teardown (agent-session-runtime.js): the
      // current session is untouched, so this offers a retry instead of treating it as fatal (Pi's
      // handleResumeSession, interactive-mode.js ~4658-4691).
      const issue = missingSessionCwdIssue(error);
      if (issue === undefined) return fatal("Failed to switch session", error);
      const selectedCwd = await confirmMissingSessionCwd(commandHost, issue);
      if (selectedCwd === undefined) return { cancelled: true };
      try {
        return await withSessionReplacement(() => originalSwitchSession(sessionPath, { ...switchOptions, cwdOverride: selectedCwd }));
      } catch (retryError) {
        return fatal("Failed to switch session", retryError);
      }
    }
  };

  // ── session binding (also after /new, /resume, /reload) ───────────────────
  let unsubscribe: (() => void) | undefined;

  function onEvent(event: AgentSessionEvent): void {
    const now = Date.now();
    switch (event.type) {
      case "agent_start":
        turn = { startedAt: now, phaseStartedAt: now, activity: "Waiting for response…", outputTokens: 0, estimated: false };
        break;
      case "agent_end":
        turn = undefined;
        workingMessage = undefined;
        break;
      case "queue_update":
        queued = { steering: event.steering, followUp: event.followUp };
        break;
      case "message_update": {
        const kind = event.assistantMessageEvent.type;
        setActivity(kind.startsWith("thinking") ? "Thinking…" : kind.startsWith("toolcall") ? "Preparing tool call…" : "Responding…");
        if (turn !== undefined && event.message.role === "assistant") {
          const reported = event.message.usage?.output ?? 0;
          // Providers often report usage only at the end; estimate from streamed text until then.
          const streamed = event.message.content.reduce((sum, part) =>
            sum + (part.type === "text" ? part.text.length : part.type === "thinking" ? part.thinking.length : 0), 0);
          turn = reported > 0
            ? { ...turn, outputTokens: reported, estimated: false }
            : { ...turn, outputTokens: Math.round(streamed / 4), estimated: true };
        }
        break;
      }
      case "tool_execution_start":
        setActivity(`Running ${event.toolName}…`);
        break;
      case "tool_execution_end":
        setActivity("Waiting for response…");
        break;
      // Manual /compact runs with isStreaming false, so it needs its own turn-status entry (Pi
      // shows a CompactionStatusIndicator and lets Esc cancel it via a temporary onEscape override;
      // MMP's app.interrupt checks session.isCompacting instead, so the shared turn state suffices).
      case "compaction_start":
        turn = turn === undefined
          ? { startedAt: now, phaseStartedAt: now, activity: "Compacting…", outputTokens: 0, estimated: false }
          : { ...turn, activity: "Compacting…", phaseStartedAt: now };
        break;
      case "compaction_end":
        if (!session.isStreaming) turn = undefined;
        // Pi flushes its compaction queue unconditionally here, whether compaction succeeded,
        // failed, or was aborted by Esc; a message typed while it ran still deserves sending.
        // Except: this same event also fires as a side effect of tearing down this very session for
        // replacement (teardownCurrent aborts any running compaction before disposing the session) --
        // flushing then would send into a session about to be disposed. bind()'s unconditional
        // `compactionQueue = []` already covers dropping it (bug 4).
        if (!sessionReplacementInFlight) void flushCompactionQueue();
        break;
      case "auto_retry_start":
        turn = turn === undefined
          ? { startedAt: now, phaseStartedAt: now, activity: `Retrying (${event.attempt}/${event.maxAttempts})…`, outputTokens: 0, estimated: false }
          : { ...turn, activity: `Retrying (${event.attempt}/${event.maxAttempts})…`, phaseStartedAt: now };
        break;
      case "auto_retry_end":
        if (!session.isStreaming) turn = undefined;
        break;
      default:
        break;
    }
    transcript.handle(event);
  }

  async function bind(next: AgentSession): Promise<void> {
    session = next;
    // Pi's renderCurrentSessionState (interactive-mode.js ~1615), called on every rebind: a message
    // queued during the outgoing session's compaction belongs to a session that no longer exists.
    compactionQueue = [];
    branch = readGitBranch(session.sessionManager.getCwd());
    unsubscribe?.();
    unsubscribe = session.subscribe(onEvent);
    transcript.reset(session);
    // Pi shows startup diagnostics in the transcript, not stderr (interactive-mode.js ~817-828);
    // `runtime.diagnostics` reflects whichever session this bind() is for (AgentSessionRuntime.apply
    // runs before rebindSession fires), so this covers /new and /resume too, not just startup.
    for (const diagnostic of runtime.diagnostics) {
      transcript.notice(diagnostic.message, diagnostic.type);
    }
    queued = { steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() };
    await session.bindExtensions({
      uiContext,
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (actionOptions) => runtime.newSession(actionOptions),
        fork: (entryId, actionOptions) => runtime.fork(entryId, actionOptions),
        navigateTree: async (targetId, actionOptions) => {
          // Same gap as the /tree command above: session.navigateTree() never triggers
          // setRebindSession, so an extension calling this action directly needs the same replay.
          const result = await session.navigateTree(targetId, actionOptions);
          if (!result.cancelled && !result.aborted) {
            transcript.reset(session);
            tui.requestRender();
          }
          return result;
        },
        switchSession: async (sessionPath, actionOptions) => {
          // Check before the runtime tears down the current session (docs/tui-design.md §15): a
          // refused switch must leave the running session exactly as it was. crossProjectRefusal
          // can itself throw (a malformed session file); runtime.switchSession below cannot -- it's
          // wrapped (see the session-replacement guard, above) to handle MissingSessionCwdError and
          // any other failure itself (bug 7).
          let refusal: string | undefined;
          try {
            refusal = crossProjectRefusal(sessionPath, options.projectIdentity);
          } catch (error) {
            transcript.notice(`Could not switch session: ${errorText(error)}`, "error");
            return { cancelled: true };
          }
          if (refusal !== undefined) {
            transcript.notice(refusal, "warning");
            return { cancelled: true };
          }
          return runtime.switchSession(sessionPath, actionOptions);
        },
        reload: () => reloadSession(),
      },
      shutdownHandler: () => void exit(0),
      // Pi's own abortHandler (interactive-mode.js ~1437-1439): an extension calling ctx.abort()
      // must not drop whatever is queued, and must abort even when nothing was queued.
      abortHandler: () => {
        restoreQueuedMessagesToEditor();
        void session.abort();
      },
      onError: (error) => transcript.notice(`Extension error (${error.extensionPath}, ${error.event}): ${error.error}`, "error"),
    });
    // bindExtensions re-registers extension providers, which starts an un-awaited auth refresh in Pi.
    await runtime.services.modelRuntime.refresh({ allowNetwork: false });
    resetAutocomplete();
    tui.requestRender();
  }

  /** Widget/header/footer/status state an extension sets up again on `session_start`; cleared
   * before that fires so nothing stale from the old session lingers (docs/tui-design.md 6.3). */
  function clearExtensionUiState(): void {
    statuses.clear();
    widgets.aboveEditor.clear();
    widgets.belowEditor.clear();
    rebuildWidgets();
    surface.setHeader(undefined);
    surface.setFooter(undefined);
  }
  runtime.setBeforeSessionInvalidate(clearExtensionUiState);
  runtime.setRebindSession(bind);

  // `session.reload()` keeps the same AgentSession instance (no `switchSession`/`newSession`
  // replacement), so `setBeforeSessionInvalidate`/`setRebindSession` never fire for it; Pi's own
  // handleReloadCommand does the equivalent host-side work inline, which this mirrors.
  async function reloadSession(): Promise<void> {
    clearExtensionUiState();
    // The message components already in the transcript hold markdown transformers and tool
    // renderers captured from the extension runner reload() is about to replace; rebuild them
    // against the new one, like Pi's handleReloadCommand's own beforeSessionStart callback does.
    await session.reload({ beforeSessionStart: () => transcript.reset(session) });
    // Re-registering extension providers on reload can race an un-awaited auth refresh, same as bind().
    await runtime.services.modelRuntime.refresh({ allowNetwork: false });
    keybindings.reload();
    resetAutocomplete();
    tui.requestRender();
  }

  // ── input ─────────────────────────────────────────────────────────────────
  // Pi's setupEditorSubmitHandler is only installed once startup (managed-tool setup, then
  // rebindCurrentSession) finishes; until then defaultEditor.onSubmit is handleStartupSubmit,
  // which just puts the text back with a status line instead of racing session.prompt() against
  // a session whose extensions aren't bound yet. `ready` mirrors that gate; flips true once the
  // first bind() below resolves.
  let ready = false;

  /** Pi's isExtensionCommand (interactive-mode.js ~3788-3795): an extension-registered slash
   * command, which runs immediately even during compaction instead of queuing. */
  function isExtensionCommandText(text: string): boolean {
    const [, command] = /^\/(\S+)/.exec(text.trim()) ?? [];
    return command !== undefined &&
      session.extensionRunner.getRegisteredCommands().some((registered) => registered.invocationName === command);
  }

  /** Pi's clearAllQueues (interactive-mode.js ~3729): the session's own steering/follow-up queue
   * plus app.ts's own compaction queue, combined and cleared. */
  function clearAllQueues(): { steering: string[]; followUp: string[] } {
    const { steering, followUp } = session.clearQueue();
    const compactionSteering = compactionQueue.filter((message) => message.mode === "steer").map((message) => message.text);
    const compactionFollowUp = compactionQueue.filter((message) => message.mode === "followUp").map((message) => message.text);
    compactionQueue = [];
    return { steering: [...steering, ...compactionSteering], followUp: [...followUp, ...compactionFollowUp] };
  }

  /** Pi's restoreQueuedMessagesToEditor (interactive-mode.js ~3761): put any queued steering/
   * follow-up text back in the editor (ahead of whatever the user already typed). Shared by Esc,
   * Ctrl+C, Alt+Up (via CommandHost) and an extension's ctx.abort() (the abortHandler above), so a
   * turn or compaction can never be aborted with its queue silently discarded. */
  function restoreQueuedMessagesToEditor(): number {
    const { steering, followUp } = clearAllQueues();
    const queued = [...steering, ...followUp];
    if (queued.length === 0) return 0;
    const queuedText = queued.join("\n\n");
    const current = editor.getText();
    editor.setText([queuedText, current].filter((text) => text.trim() !== "").join("\n\n"));
    tui.requestRender();
    return queued.length;
  }

  /** Pi's flushCompactionQueue (interactive-mode.js ~3796-3866), the non-retry branch: extension
   * commands ahead of the first real prompt run immediately; the first real prompt starts a turn
   * without being awaited; anything after it steers/follows-up into that same turn instead of
   * waiting and starting a separate one. On failure, the messages go back into the compaction queue
   * (not the editor) with a notice, like Pi's restoreQueue. */
  async function flushCompactionQueue(): Promise<void> {
    if (compactionQueue.length === 0) return;
    const messages = compactionQueue;
    compactionQueue = [];
    tui.requestRender();
    const restoreQueue = (error: unknown): void => {
      session.clearQueue();
      compactionQueue = messages;
      tui.requestRender();
      transcript.notice(`Failed to send queued message${messages.length > 1 ? "s" : ""}: ${errorText(error)}`, "error");
    };
    try {
      const firstPromptIndex = messages.findIndex((message) => !isExtensionCommandText(message.text));
      if (firstPromptIndex === -1) {
        for (const message of messages) await session.prompt(message.text);
        return;
      }
      const preCommands = messages.slice(0, firstPromptIndex);
      const firstPrompt = messages[firstPromptIndex]!;
      const rest = messages.slice(firstPromptIndex + 1);
      for (const message of preCommands) await session.prompt(message.text);
      const promptPromise = session
        .prompt(firstPrompt.text, session.isStreaming ? { streamingBehavior: firstPrompt.mode } : undefined)
        .catch((error: unknown) => restoreQueue(error));
      for (const message of rest) {
        if (isExtensionCommandText(message.text)) await session.prompt(message.text);
        else if (message.mode === "followUp") await session.followUp(message.text);
        else await session.steer(message.text);
      }
      void promptPromise;
    } catch (error) {
      restoreQueue(error);
    }
  }

  async function submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (!ready) {
      // Mirrors Pi's handleStartupSubmit.
      editor.setText(text);
      transcript.notice("Startup is still in progress; try again in a moment.");
      return;
    }
    editor.addToHistory(text);
    editor.setText("");
    const [, command, commandArgs = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed) ?? [];
    const builtin = command === undefined ? undefined : findBuiltin(command);
    if (builtin?.kind === "run") {
      try {
        await builtin.command.run(commandHost, commandArgs);
      } catch (error) {
        transcript.notice(`/${command} failed: ${errorText(error)}`, "error");
      }
      return;
    }
    // A planned or excluded built-in name may still be an extension's command.
    const isExtensionCommand = command !== undefined &&
      session.extensionRunner.getRegisteredCommands().some((registered) => registered.invocationName === command);
    if (builtin !== undefined && !isExtensionCommand) {
      transcript.notice(builtin.message, "warning");
      editor.setText(text);
      return;
    }
    if (await runUserBash(commandHost, trimmed)) return;
    if (session.isCompacting) {
      // session.prompt() throws while compaction is running (Pi's queueCompactionMessage);
      // MMP's Enter is Pi's Alt+Enter follow-up semantics (docs/tui-design.md 4.7 table). An
      // extension command runs immediately even during compaction instead of queuing (Pi's
      // handleFollowUp/handleSubmit, interactive-mode.js ~2604-2611/~3530-3538).
      if (isExtensionCommand) {
        try {
          await session.prompt(text);
        } catch (error) {
          transcript.notice(errorText(error), "error");
        }
        return;
      }
      compactionQueue.push({ text, mode: "followUp" });
      transcript.notice("Queued message for after compaction.");
      tui.requestRender();
      return;
    }
    try {
      await session.prompt(text, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
    } catch (error) {
      // No model, no auth: say why and keep the text.
      transcript.notice(errorText(error), "error");
      if (editor.getText() === "") editor.setText(text);
    }
  }
  editor.onSubmit = (text) => void submit(text);

  // Pi binds these on the editor itself (defaultEditor.onAction/onEscape/onCtrlD), so they only
  // fire when the editor has focus; a dialog/selector taking the editor slot (takeEditorSlot,
  // above) gets every key first otherwise, since pi-tui runs input listeners before the focused
  // component (bug: Esc/Ctrl+D/Ctrl+C/Ctrl+L would hit the app instead of the open dialog).
  const keyActions = createKeyActions();
  tui.addInputListener((data) => {
    if (tui.getFocusedComponent() !== editor) return undefined;
    const action = keyActions.find((candidate) =>
      keybindings.matches(data, candidate.id as never) && (candidate.when?.(commandHost) ?? true));
    if (action === undefined) return undefined;
    void Promise.resolve(action.run(commandHost)).catch((error: unknown) =>
      transcript.notice(errorText(error), "error"));
    tui.requestRender();
    return { consume: true };
  });

  tui.start();
  tui.setFocus(editor);
  try {
    await bind(session);
  } catch (error) {
    await exit(1);
    throw error;
  }
  ready = true;
  if (options.resumeOnStart === true) {
    await runResume(commandHost);
  }
  // Only on the very first bind: /new, /resume and /reload also call bind() and must not replay it.
  // Pi's own interactive-mode.js (~855-864): sent directly through session.prompt(), not through
  // submit()'s full pipeline -- submit() clears the editor/history and runs MMP's built-ins (e.g.
  // `mmp /new`), which would wipe whatever the startup gate above just put back into the editor.
  for (const message of options.initialMessages ?? []) {
    if (exiting) break;
    try {
      await session.prompt(message);
    } catch (error) {
      transcript.notice(errorText(error), "error");
    }
  }

  const code = await finished;
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  process.off("uncaughtException", onCrash);
  process.off("unhandledRejection", onCrash);
  unsubscribe?.();
  return code;
}
