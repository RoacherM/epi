// MMP TUI v2: fullscreen grok-build layout, transcript, prompt, extension host, lifecycle.
// Layout and data flow follow docs/tui-design.md 2.2 and 4.1.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSelectListTheme, } from "@earendil-works/pi-coding-agent";
import { runUserBash } from "./bash-block.js";
import { headerBar, PromptFrame, queuedMessagesBar, shortcutsBar, TurnStatus, } from "./chrome.js";
import { findBuiltin, slashCompletions } from "./builtins.js";
import { errorText } from "./errors.js";
import { createExtensionUIContext } from "./ext-host.js";
import { installKeybindings } from "./keybindings.js";
import { createKeyActions } from "./keys.js";
import { piTui } from "./pi-tui.js";
import { crossProjectRefusal } from "./project-guard.js";
import { runResume } from "./session-commands.js";
import { Transcript } from "./transcript.js";
// One instance per layout slot: the layout engine keys slots by component identity.
const blank = () => ({ render: () => [""], invalidate() { } });
/** grok's horizontal margin: two columns on each side. */
function inset(component, columns = 2) {
    return {
        render: (width) => component.render(Math.max(1, width - columns * 2)).map((line) => `${" ".repeat(columns)}${line}`),
        invalidate: () => component.invalidate(),
    };
}
function readGitBranch(cwd) {
    for (let dir = cwd;; dir = dirname(dir)) {
        try {
            const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
            return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
        }
        catch {
            if (dirname(dir) === dir)
                return undefined;
        }
    }
}
export async function runTuiApp(options) {
    const { runtime, theme, cwd } = options;
    const terminal = options.terminal ?? new piTui.ProcessTerminal();
    const keybindings = installKeybindings(options.agentDir);
    const tui = new piTui.TuiAltScreen(terminal, false, options.logDirectory, {
        scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest ")),
    });
    let session = runtime.session;
    const transcript = new Transcript(tui, theme, session);
    const statuses = new Map();
    const widgets = { aboveEditor: new Map(), belowEditor: new Map() };
    let toolsExpanded = false;
    let turn;
    let queued = { steering: [], followUp: [] };
    // Messages submitted while compaction is running (Pi's compactionQueuedMessages): session.prompt()
    // throws during compaction, so these are held here and sent once compaction_end fires.
    let compactionQueue = [];
    let workingMessage;
    let workingVisible = true;
    let branch = readGitBranch(cwd);
    // True while a dialog/selector (ui.select, /model, /login, …) occupies the editor slot; the app
    // key table and the shortcuts bar both read it (docs/tui-design.md 4.1: the bar follows focus).
    let editorSlotHasDialog = false;
    // ── layout (grok notes 2.2): header, transcript, turn status, prompt, shortcuts ──
    const widgetsAbove = new piTui.Container();
    const editorSlot = new piTui.Container();
    const widgetsBelow = new piTui.Container();
    const footerSlot = new piTui.Container();
    const editor = new piTui.Editor(tui, {
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
    const turnStatus = new TurnStatus(theme, () => (turn === undefined || !workingVisible ? undefined : { ...turn, activity: workingMessage ?? turn.activity }), () => tui.requestRender());
    const defaultFooter = shortcutsBar(theme, () => {
        const shortcuts = editorSlotHasDialog
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
    const turnGap = { render: () => (turn === undefined ? [] : [""]), invalidate() { } };
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
    function rebuildWidgets() {
        widgetsAbove.clear();
        widgetsBelow.clear();
        for (const component of widgets.aboveEditor.values())
            widgetsAbove.addChild(component);
        for (const component of widgets.belowEditor.values())
            widgetsBelow.addChild(component);
    }
    /** Activity label shown on the turn status row; the phase timer restarts when it changes. */
    function setActivity(activity) {
        if (turn === undefined || turn.activity === activity)
            return;
        turn = { ...turn, activity, phaseStartedAt: Date.now() };
        tui.requestRender();
    }
    // ── autocomplete ──────────────────────────────────────────────────────────
    let autocomplete = new piTui.CombinedAutocompleteProvider([], cwd, null);
    // Rebuilt in bind() (after a /new, /resume, /reload, or fork), so this always reads the cwd of
    // whichever session is bound then, not the cwd the app launched with.
    function resetAutocomplete() {
        autocomplete = new piTui.CombinedAutocompleteProvider(slashCompletions(session), session.sessionManager.getCwd(), null);
        editor.setAutocompleteProvider(autocomplete);
    }
    // ── extension host ────────────────────────────────────────────────────────
    const surface = {
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
            if (component !== undefined)
                transcript.header.addChild(component);
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
            if (component !== undefined)
                widgets[placement].set(key, component);
            rebuildWidgets();
            tui.requestRender();
        },
        setStatus(key, text) {
            if (text === undefined)
                statuses.delete(key);
            else
                statuses.set(key, text);
            tui.requestRender();
        },
        setWorking(change) {
            if ("message" in change)
                workingMessage = change.message;
            if (change.visible !== undefined)
                workingVisible = change.visible;
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
    const commandHost = {
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
    let resolveRun;
    const finished = new Promise((resolve) => {
        resolveRun = resolve;
    });
    async function exit(code = 0) {
        if (exiting)
            return;
        exiting = true;
        turnStatus.stop();
        tui.stop();
        try {
            await runtime.dispose();
        }
        finally {
            resolveRun(code);
        }
    }
    const onSignal = () => void exit(0);
    const onCrash = (error) => {
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
    let unsubscribe;
    function onEvent(event) {
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
                    const streamed = event.message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : part.type === "thinking" ? part.thinking.length : 0), 0);
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
                if (!session.isStreaming)
                    turn = undefined;
                // Pi flushes its compaction queue unconditionally here, whether compaction succeeded,
                // failed, or was aborted by Esc; a message typed while it ran still deserves sending.
                void flushCompactionQueue();
                break;
            case "auto_retry_start":
                turn = turn === undefined
                    ? { startedAt: now, phaseStartedAt: now, activity: `Retrying (${event.attempt}/${event.maxAttempts})…`, outputTokens: 0, estimated: false }
                    : { ...turn, activity: `Retrying (${event.attempt}/${event.maxAttempts})…`, phaseStartedAt: now };
                break;
            case "auto_retry_end":
                if (!session.isStreaming)
                    turn = undefined;
                break;
            default:
                break;
        }
        transcript.handle(event);
    }
    async function bind(next) {
        session = next;
        branch = readGitBranch(session.sessionManager.getCwd());
        unsubscribe?.();
        unsubscribe = session.subscribe(onEvent);
        transcript.reset(session);
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
                    try {
                        // Check before the runtime tears down the current session (docs/tui-design.md §15): a
                        // refused switch must leave the running session exactly as it was.
                        const refusal = crossProjectRefusal(sessionPath, options.projectIdentity);
                        if (refusal !== undefined) {
                            transcript.notice(refusal, "warning");
                            return { cancelled: true };
                        }
                        return await runtime.switchSession(sessionPath, actionOptions);
                    }
                    catch (error) {
                        transcript.notice(`Could not switch session: ${errorText(error)}`, "error");
                        return { cancelled: true };
                    }
                },
                reload: () => reloadSession(),
            },
            shutdownHandler: () => void exit(0),
            onError: (error) => transcript.notice(`Extension error (${error.extensionPath}, ${error.event}): ${error.error}`, "error"),
        });
        // bindExtensions re-registers extension providers, which starts an un-awaited auth refresh in Pi.
        await runtime.services.modelRuntime.refresh({ allowNetwork: false });
        resetAutocomplete();
        tui.requestRender();
    }
    /** Widget/header/footer/status state an extension sets up again on `session_start`; cleared
     * before that fires so nothing stale from the old session lingers (docs/tui-design.md 6.3). */
    function clearExtensionUiState() {
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
    async function reloadSession() {
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
    /** Pi's flushCompactionQueue: sent once compaction_end fires, in submission order. The first
     * call starts a normal turn; later ones steer/follow-up into the turn it just started. */
    async function flushCompactionQueue() {
        if (compactionQueue.length === 0)
            return;
        const messages = compactionQueue;
        compactionQueue = [];
        tui.requestRender();
        for (const message of messages) {
            try {
                await session.prompt(message.text, session.isStreaming ? { streamingBehavior: message.mode } : undefined);
            }
            catch (error) {
                transcript.notice(errorText(error), "error");
            }
        }
    }
    async function submit(text) {
        const trimmed = text.trim();
        if (trimmed === "")
            return;
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
            }
            catch (error) {
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
        if (await runUserBash(commandHost, trimmed))
            return;
        if (session.isCompacting) {
            // session.prompt() throws while compaction is running (Pi's queueCompactionMessage);
            // MMP's Enter is Pi's Alt+Enter follow-up semantics (docs/tui-design.md 4.7 table).
            compactionQueue.push({ text, mode: "followUp" });
            transcript.notice("Queued message for after compaction.");
            tui.requestRender();
            return;
        }
        try {
            await session.prompt(text, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
        }
        catch (error) {
            // No model, no auth: say why and keep the text.
            transcript.notice(errorText(error), "error");
            if (editor.getText() === "")
                editor.setText(text);
        }
    }
    editor.onSubmit = (text) => void submit(text);
    // Pi binds these on the editor itself (defaultEditor.onAction/onEscape/onCtrlD), so they only
    // fire when the editor has focus; a dialog/selector taking the editor slot (takeEditorSlot,
    // above) gets every key first otherwise, since pi-tui runs input listeners before the focused
    // component (bug: Esc/Ctrl+D/Ctrl+C/Ctrl+L would hit the app instead of the open dialog).
    const keyActions = createKeyActions();
    tui.addInputListener((data) => {
        if (tui.getFocusedComponent() !== editor)
            return undefined;
        const action = keyActions.find((candidate) => keybindings.matches(data, candidate.id) && (candidate.when?.(commandHost) ?? true));
        if (action === undefined)
            return undefined;
        void Promise.resolve(action.run(commandHost)).catch((error) => transcript.notice(errorText(error), "error"));
        tui.requestRender();
        return { consume: true };
    });
    tui.start();
    tui.setFocus(editor);
    try {
        await bind(session);
    }
    catch (error) {
        await exit(1);
        throw error;
    }
    ready = true;
    if (options.resumeOnStart === true) {
        await runResume(commandHost);
    }
    // Only on the very first bind: /new, /resume and /reload also call bind() and must not replay it.
    for (const message of options.initialMessages ?? []) {
        if (exiting)
            break;
        await submit(message);
    }
    const code = await finished;
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
    unsubscribe?.();
    return code;
}
//# sourceMappingURL=app.js.map