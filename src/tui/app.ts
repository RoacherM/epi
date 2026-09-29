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
import { headerBar, PromptFrame, type Shortcut, shortcutsBar, type TurnState, TurnStatus } from "./chrome.js";
import { findBuiltin, slashCompletions } from "./builtins.js";
import type { CommandHost } from "./command-host.js";
import { createExtensionUIContext, type HostSurface } from "./ext-host.js";
import { installKeybindings } from "./keybindings.js";
import { createKeyActions } from "./keys.js";
import { piTui } from "./pi-tui.js";
import { Transcript } from "./transcript.js";

export interface TuiAppOptions {
  runtime: AgentSessionRuntime;
  theme: Theme;
  cwd: string;
  /** MMP's Pi state directory (~/.mmp/pi): keybindings.json is read from here. */
  agentDir: string;
  logDirectory: string;
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
  const transcript = new Transcript(tui, theme, cwd, session);
  const statuses = new Map<string, string>();
  const widgets = { aboveEditor: new Map<string, Component>(), belowEditor: new Map<string, Component>() };
  let toolsExpanded = false;
  let turn: TurnState | undefined;
  let workingMessage: string | undefined;
  let workingVisible = true;
  let branch = readGitBranch(cwd);

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
    return { branch, cwd, contextTokens: usage?.tokens ?? undefined, contextWindow: usage?.contextWindow };
  });
  const turnStatus = new TurnStatus(
    theme,
    () => (turn === undefined || !workingVisible ? undefined : { ...turn, activity: workingMessage ?? turn.activity }),
    () => tui.requestRender(),
  );
  const defaultFooter = shortcutsBar(theme, () => {
    const shortcuts: Shortcut[] = turn === undefined
      ? [{ key: "Shift+Tab", label: "thinking" }, { key: "Ctrl+o", label: "tools" }, { key: "/", label: "commands" }, { key: "Ctrl+d", label: "quit" }]
      : [{ key: "Esc", label: "stop" }, { key: "Ctrl+c", label: "cancel" }, { key: "Ctrl+o", label: "tools" }];
    return { shortcuts, right: theme.fg("muted", [...statuses.values()].join(" · ")) };
  });
  footerSlot.addChild(defaultFooter);

  const scroll = new piTui.ScrollView(inset(transcript.root), { follow: "end", primary: true, scrollbar: "auto" });
  const turnGap: Component = { render: () => (turn === undefined ? [] : [""]), invalidate() {} };
  tui.setLayoutRoot(new piTui.VStack([
    { component: blank(), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(header), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: blank(), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: turnGap, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
    { component: inset(turnStatus), basis: "auto", grow: 0, shrink: 1, minSize: 0 },
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
  function resetAutocomplete(): void {
    autocomplete = new piTui.CombinedAutocompleteProvider(slashCompletions(session), cwd, null);
    editor.setAutocompleteProvider(autocomplete);
  }

  // ── extension host ────────────────────────────────────────────────────────
  const surface: HostSurface = {
    tui,
    theme,
    takeEditorSlot(component) {
      editorSlot.clear();
      editorSlot.addChild(component);
      tui.setFocus(component);
      tui.requestRender();
      return () => {
        editorSlot.clear();
        editorSlot.addChild(prompt);
        tui.setFocus(editor);
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
    cwd,
    runtime,
    session: () => session,
    takeEditorSlot: (component) => surface.takeEditorSlot(component),
    notice: (text, tone) => transcript.notice(text, tone ?? "info"),
    addBlock: (component) => transcript.addBlock(component),
    getEditorText: () => editor.getText(),
    setEditorText: (text) => surface.setEditorText(text),
    isWorking: () => turn !== undefined,
    toggleToolsExpanded: () => surface.setToolsExpanded(!toolsExpanded),
    exit: (code) => exit(code),
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
      default:
        break;
    }
    transcript.handle(event);
  }

  async function bind(next: AgentSession): Promise<void> {
    session = next;
    branch = readGitBranch(session.sessionManager.getCwd());
    unsubscribe?.();
    unsubscribe = session.subscribe(onEvent);
    transcript.reset(session);
    await session.bindExtensions({
      uiContext,
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (actionOptions) => runtime.newSession(actionOptions),
        fork: (entryId, actionOptions) => runtime.fork(entryId, actionOptions),
        navigateTree: (targetId, actionOptions) => session.navigateTree(targetId, actionOptions),
        switchSession: (sessionPath, actionOptions) => runtime.switchSession(sessionPath, actionOptions),
        reload: () => session.reload(),
      },
      shutdownHandler: () => void exit(0),
      onError: (error) => transcript.notice(`Extension error (${error.extensionPath}, ${error.event}): ${error.error}`, "error"),
    });
    // bindExtensions re-registers extension providers, which starts an un-awaited auth refresh in Pi.
    await runtime.services.modelRuntime.refresh({ allowNetwork: false });
    resetAutocomplete();
    tui.requestRender();
  }

  runtime.setBeforeSessionInvalidate(() => {
    statuses.clear();
    widgets.aboveEditor.clear();
    widgets.belowEditor.clear();
    rebuildWidgets();
    surface.setHeader(undefined);
    surface.setFooter(undefined);
  });
  runtime.setRebindSession(bind);

  // ── input ─────────────────────────────────────────────────────────────────
  async function submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    editor.addToHistory(text);
    editor.setText("");
    const [, command, commandArgs = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed) ?? [];
    const builtin = command === undefined ? undefined : findBuiltin(command);
    if (builtin?.kind === "run") {
      try {
        await builtin.command.run(commandHost, commandArgs);
      } catch (error) {
        transcript.notice(`/${command} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
    try {
      await session.prompt(text, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
    } catch (error) {
      // No model, no auth, compaction running: say why and keep the text.
      transcript.notice(error instanceof Error ? error.message : String(error), "error");
      if (editor.getText() === "") editor.setText(text);
    }
  }
  editor.onSubmit = (text) => void submit(text);

  const keyActions = createKeyActions();
  tui.addInputListener((data) => {
    const action = keyActions.find((candidate) =>
      keybindings.matches(data, candidate.id as never) && (candidate.when?.(commandHost) ?? true));
    if (action === undefined) return undefined;
    void Promise.resolve(action.run(commandHost)).catch((error: unknown) =>
      transcript.notice(error instanceof Error ? error.message : String(error), "error"));
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

  const code = await finished;
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  process.off("uncaughtException", onCrash);
  process.off("unhandledRejection", onCrash);
  unsubscribe?.();
  return code;
}
