// MMP TUI v0 (milestone M2): fullscreen layout, transcript, prompt, extension host, lifecycle.
// Layout and data flow follow docs/tui-design.md 2.2 and 4.1; grok visuals arrive in M4.
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, Container, Editor, Terminal } from "@earendil-works/pi-tui";

import { createExtensionUIContext, type HostSurface } from "./ext-host.js";
import { piTui } from "./pi-tui.js";
import { Transcript } from "./transcript.js";

// Pi's built-in slash commands are implemented inside its own interactive mode, which MMP replaces.
// v0 handles /quit and /new; the rest arrive in M3 (tui-design 4.6).
const PI_BUILTIN_COMMANDS = new Set([
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
  "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
  "compact", "resume", "reload", "quit",
]);

export interface TuiAppOptions {
  runtime: AgentSessionRuntime;
  theme: Theme;
  cwd: string;
  logDirectory: string;
  terminal?: Terminal;
}

function lineComponent(render: (width: number) => string): Component {
  return { render: (width) => [render(width)], invalidate() {} };
}

export async function runTuiApp(options: TuiAppOptions): Promise<number> {
  const { runtime, theme, cwd } = options;
  const terminal = options.terminal ?? new piTui.ProcessTerminal();
  const tui = new piTui.TuiAltScreen(terminal, false, options.logDirectory, {
    scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest ")),
  });

  let session: AgentSession = runtime.session;
  const transcript = new Transcript(tui, theme, cwd, session);
  const statuses = new Map<string, string>();
  const widgets = { aboveEditor: new Map<string, Component>(), belowEditor: new Map<string, Component>() };
  let toolsExpanded = false;
  let working = false;
  let workingMessage: string | undefined;
  let workingVisible = true;
  let loader: InstanceType<typeof piTui.Loader> | undefined;
  let lastCtrlC = 0;

  // ── layout ────────────────────────────────────────────────────────────────
  const statusSlot: Container = new piTui.Container();
  const widgetsAbove: Container = new piTui.Container();
  const editorSlot: Container = new piTui.Container();
  const widgetsBelow: Container = new piTui.Container();
  const footerSlot: Container = new piTui.Container();
  const editor: Editor = new piTui.Editor(tui, {
    borderColor: (text) => theme.fg("border", text),
    selectList: getSelectListTheme(),
  });
  editorSlot.addChild(editor);

  const defaultFooter = lineComponent((width) => {
    const model = session.model;
    const usage = session.getContextUsage();
    // Without credentials Pi keeps a placeholder model; /login is still classic-only until M3.
    const hasModel = model !== undefined && runtime.services.modelRuntime.getAvailableSnapshot().length > 0;
    const left = [
      hasModel ? `${model.provider}/${model.id}` : "no model available · log in once with classic mmp (/login)",
      session.thinkingLevel,
      usage?.percent == null ? undefined : `ctx ${Math.round(usage.percent)}%`,
      ...statuses.values(),
    ].filter((part) => part !== undefined).join(" · ");
    const right = working ? "esc stop" : "ctrl+d quit";
    const gap = Math.max(1, width - piTui.visibleWidth(left) - piTui.visibleWidth(right));
    return piTui.truncateToWidth(theme.fg("muted", `${left}${" ".repeat(gap)}${right}`), width);
  });
  footerSlot.addChild(defaultFooter);

  const scroll = new piTui.ScrollView(transcript.root, { follow: "end", primary: true, scrollbar: "auto" });
  const dock = new piTui.VStack([
    { component: statusSlot, shrink: 1, minSize: 0 },
    { component: widgetsAbove, shrink: 1, minSize: 0 },
    { component: editorSlot, shrink: 1, minSize: 3 },
    { component: widgetsBelow, shrink: 1, minSize: 0 },
    { component: footerSlot, shrink: 1, minSize: 0 },
  ]);
  // Fullscreen layout: the transcript scrolls, the dock stays at the bottom.
  tui.setLayoutRoot(new piTui.VStack([
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]));

  function rebuildWidgets(): void {
    widgetsAbove.clear();
    widgetsBelow.clear();
    for (const component of widgets.aboveEditor.values()) widgetsAbove.addChild(component);
    for (const component of widgets.belowEditor.values()) widgetsBelow.addChild(component);
  }

  function renderWorking(): void {
    statusSlot.clear();
    loader?.stop();
    loader = undefined;
    if (working && workingVisible) {
      loader = new piTui.Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), workingMessage ?? "Working…");
      loader.start();
      statusSlot.addChild(loader);
    }
    tui.requestRender();
  }

  // ── autocomplete ──────────────────────────────────────────────────────────
  let autocomplete: AutocompleteProvider = new piTui.CombinedAutocompleteProvider([], cwd, null);
  function resetAutocomplete(): void {
    const commands = [
      { name: "quit", description: "Quit MMP" },
      { name: "new", description: "Start a new session" },
      ...session.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        ...(command.description === undefined ? {} : { description: command.description }),
      })),
    ];
    autocomplete = new piTui.CombinedAutocompleteProvider(commands, cwd, null);
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
        editorSlot.addChild(editor);
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
      renderWorking();
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

  // ── lifecycle ─────────────────────────────────────────────────────────────
  let exiting = false;
  let resolveRun!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    resolveRun = resolve;
  });

  async function exit(code = 0): Promise<void> {
    if (exiting) return;
    exiting = true;
    loader?.stop();
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
    if (event.type === "agent_start") {
      working = true;
      renderWorking();
    } else if (event.type === "agent_end") {
      working = false;
      workingMessage = undefined;
      renderWorking();
    }
    transcript.handle(event);
  }

  async function bind(next: AgentSession): Promise<void> {
    session = next;
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
    if (trimmed === "/quit") {
      await exit(0);
      return;
    }
    if (trimmed === "/new") {
      await runtime.newSession();
      return;
    }
    const command = /^\/([^\s]+)/.exec(trimmed)?.[1];
    const isExtensionCommand = command !== undefined &&
      session.extensionRunner.getRegisteredCommands().some((registered) => registered.invocationName === command);
    if (command !== undefined && !isExtensionCommand && PI_BUILTIN_COMMANDS.has(command)) {
      transcript.notice(`/${command} is not in MMP TUI v2 yet; use classic mmp (without MMP_TUI=v2) for now.`, "warning");
      editor.setText(text);
      return;
    }
    if (trimmed.startsWith("!")) {
      transcript.notice("! bash commands are not in MMP TUI v2 yet.", "warning");
      editor.setText(text);
      return;
    }
    try {
      await session.prompt(text, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
    } catch (error) {
      // No model, no auth, compaction running: say why and keep the text.
      transcript.notice(error instanceof Error ? error.message : String(error), "error");
      if (editor.getText() === "") editor.setText(text);
    }
  }
  editor.onSubmit = (text) => void submit(text);

  tui.addInputListener((data) => {
    if (piTui.matchesKey(data, "escape") && session.isStreaming) {
      void session.abort();
      return { consume: true };
    }
    if (piTui.matchesKey(data, "ctrl+c")) {
      if (editor.getText() !== "") {
        editor.setText("");
      } else if (session.isStreaming) {
        void session.abort();
      } else if (Date.now() - lastCtrlC < 1000) {
        void exit(0);
      } else {
        lastCtrlC = Date.now();
        transcript.notice("Press Ctrl+C again to quit.");
      }
      tui.requestRender();
      return { consume: true };
    }
    if (piTui.matchesKey(data, "ctrl+d") && editor.getText() === "") {
      void exit(0);
      return { consume: true };
    }
    return undefined;
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
