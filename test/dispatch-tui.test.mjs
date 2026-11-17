import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createDispatchExtension } from "../dist/extensions/dispatch/index.js";
import { DispatchRuntime } from "../dist/extensions/dispatch/runtime.js";
import { formatDispatchStatusText } from "../dist/extensions/dispatch/tui-views.js";

const plainTheme = {
  fg: (_tone, text) => text,
  bg: (_tone, text) => text,
  bold: (text) => text,
};

function makeHarness(t, host = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-tui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new DispatchRuntime({ stateDir: join(dir, "state"), ...host }, "root");
  t.after(() => runtime.shutdown());

  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  let notifyRenderer;
  let statusCalls = [];
  let notices = [];
  let inputListeners = new Set();
  let lastOverlay = undefined;

  const ui = {
    theme: plainTheme,
    setStatus: (key, text) => { statusCalls.push({ key, text }); },
    notify: (msg, tone) => { notices.push({ msg, tone }); },
    onTerminalInput: (fn) => {
      inputListeners.add(fn);
      return () => inputListeners.delete(fn);
    },
    custom: async (factory, options) => {
      let resolved = false;
      let finish;
      const donePromise = new Promise((resolve) => { finish = resolve; });
      const tui = { requestRender() {}, terminal: { rows: 28 } };
      const component = factory(tui, plainTheme, {}, (res) => {
        if (!resolved) { resolved = true; finish(res); }
      });
      lastOverlay = { component, options, donePromise };
      return donePromise;
    },
  };

  const ctx = {
    cwd: dir,
    mode: "tui",
    hasUI: true,
    ui,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "sess-tui-1",
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
    },
  };

  const pi = {
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, spec) { commands.set(name, spec); },
    registerMessageRenderer(_type, fn) { notifyRenderer = fn; },
    appendEntry() {},
    sendMessage() {},
  };

  runtime.mount(pi);
  for (const fn of handlers.get("session_start") ?? []) fn({ reason: "startup" }, ctx);

  return {
    dir,
    runtime,
    tools,
    commands,
    handlers,
    ctx,
    get statusCalls() { return statusCalls; },
    get notices() { return notices; },
    sendKey(data) {
      for (const fn of [...inputListeners]) {
        const res = fn(data);
        if (res?.consume) return true;
      }
      return false;
    },
    get overlay() { return lastOverlay; },
    get notifyRenderer() { return notifyRenderer; },
  };
}

test("formatDispatchStatusText stays <= 14 columns across active, board, and unread states", () => {
  assert.equal(formatDispatchStatusText(0, 0, { done: 0, failed: 0 }), undefined);
  const s1 = formatDispatchStatusText(1, 0, { done: 0, failed: 0 });
  assert.equal(s1, "◐ 1 task");
  assert.ok(s1.length <= 14);

  const s2 = formatDispatchStatusText(3, 12, { done: 2, failed: 1 });
  assert.equal(s2, "◐ 3 · #12");
  assert.ok(s2.length <= 14);

  const s3 = formatDispatchStatusText(0, 5, { done: 2, failed: 1 });
  assert.equal(s3, "✓ 2 · ✗ 1");
  assert.ok(s3.length <= 14);
});

test("Alt+B passes through when idle (preserving editor word-left) and detaches foreground bash + task_wait when active", async (t) => {
  const h = makeHarness(t);

  // Idle: Alt+B (\x1bb) is NOT consumed so pi-tui cursorWordLeft keeps working.
  assert.equal(h.sendKey("\x1bb"), false);
  assert.equal(h.notices.length, 0);

  // /bg when nothing is running informs the user cleanly.
  await h.commands.get("bg").handler("", h.ctx);
  assert.match(h.notices.at(-1).msg, /Nothing running in the foreground/);

  // Start a slow foreground bash command (sync window 60s), then press Alt+B to detach it!
  const bashExec = h.tools.get("bash").execute("tc-1", { command: "sleep 30", waitMsBeforeAsync: 60_000 }, undefined, undefined, h.ctx);
  await delay(80);
  assert.equal(h.runtime.hasDetachableForeground(), true);

  const consumed = h.sendKey("\x1bb");
  assert.equal(consumed, true, "Alt+B must be consumed when detaching foreground work");
  const detachedRes = await bashExec;
  const bgId = detachedRes.details.dispatch.id;
  assert.match(bgId, /^bg_/);
  assert.match(detachedRes.content[0].text, /Running in the background/);
  assert.match(h.notices.at(-1).msg, /Moved 1 foreground item to the background/);
  assert.equal(h.statusCalls.at(-1).text, "◐ 1 task");

  // Start a foreground task_wait on that bg_* item, then run /bg to detach the wait without killing bg_*!
  const waitExec = h.tools.get("task_wait").execute("tc-2", { ids: [bgId] }, undefined, undefined, h.ctx);
  await delay(40);
  assert.equal(h.runtime.hasDetachableForeground(), true);
  await h.commands.get("bg").handler("", h.ctx);
  const waitRes = await waitExec;
  assert.match(waitRes.content[0].text, /Stopped waiting \(\/bg\)/);
  assert.equal(h.runtime.bg.summary(bgId).status, "running", "/bg detaches task_wait without killing the command");

  await h.tools.get("task_cancel").execute("tc-3", { id: bgId }, undefined, undefined, h.ctx);
});

test("/tasks and /board open the dual-tab 88% overlay, support Tab/Enter/Esc and mouse drill-down, and include host extraItems", async (t) => {
  let extraListeners = new Set();
  const extraMon = {
    id: "mon_demo1",
    active: true,
    row: () => "◐ mon_demo1 running monitor · 2 events · tail server",
    detail: () => ({ title: "monitor mon_demo1", subtitle: "running", lines: ["stdout: listening on :4319", "GET /health 200"] }),
  };
  const h = makeHarness(t, {
    ui: {
      extraItems: () => [extraMon],
      onExtraChange: (fn) => { extraListeners.add(fn); return () => extraListeners.delete(fn); },
    },
  });

  // Post a message to the board and start a daemon bash job so both tabs have live content.
  await h.tools.get("board_post").execute("b1", { text: "@parser check edge cases" }, undefined, undefined, h.ctx);
  const daemonRes = await h.tools.get("bash").execute("d1", { command: "echo boot-ok && sleep 30", isDaemon: true }, undefined, undefined, h.ctx);
  const daemonId = daemonRes.details.dispatch.id;
  await delay(60);

  // Status counts active bg + active extra monitor, plus board seq #1!
  assert.equal(h.statusCalls.at(-1).text, "◐ 2 · #1");

  // Open /tasks -> Items tab
  const tasksClosed = h.commands.get("tasks").handler("", h.ctx);
  assert.ok(h.overlay);
  assert.equal(h.overlay.options.overlay, true);
  assert.equal(h.overlay.options.overlayOptions.width, "88%");

  let rendered = h.overlay.component.render(90).join("\n");
  assert.match(rendered, /Items \(2\)/);
  assert.match(rendered, /Board \(#1\)/);
  assert.match(rendered, new RegExp(daemonId.slice(0, 12)));
  assert.match(rendered, /mon_demo1/);

  // Press Enter on first item (daemon bg job) -> drills into detail view
  h.overlay.component.handleInput("\r");
  rendered = h.overlay.component.render(90).join("\n");
  assert.match(rendered, /← Esc/);
  assert.match(rendered, /boot-ok|Full log:/);

  // Press Esc -> returns to Items list (does NOT close overlay yet)
  h.overlay.component.handleInput("\x1b");
  rendered = h.overlay.component.render(90).join("\n");
  assert.match(rendered, /Items \(2\)/);

  // Press Tab -> switches to Board tab
  h.overlay.component.handleInput("\t");
  rendered = h.overlay.component.render(90).join("\n");
  assert.match(rendered, /#1 @coordinator/);
  assert.match(rendered, /@parser check edge cases/);

  // Mouse click on Items tab (row y=1, x=4) -> switches back to Items tab, then click row y=4 (second item: mon_demo1)
  h.overlay.component.handleMouse({ type: "click", button: "left", x: 4, y: 1, screenX: 4, screenY: 1, width: 90, height: 24, shift: false, alt: false, ctrl: false });
  h.overlay.component.handleMouse({ type: "click", button: "left", x: 10, y: 4, screenX: 10, screenY: 4, width: 90, height: 24, shift: false, alt: false, ctrl: false });
  rendered = h.overlay.component.render(90).join("\n");
  assert.match(rendered, /listening on :4319/);

  // Esc back to Items, Esc again to close overlay
  h.overlay.component.handleInput("\x1b");
  h.overlay.component.handleInput("\x1b");
  await tasksClosed;

  // Direct /tasks <id> opens detail and closes on first Esc
  const directClosed = h.commands.get("tasks").handler(daemonId, h.ctx);
  assert.match(h.overlay.component.render(90).join("\n"), new RegExp(daemonId));
  h.overlay.component.handleInput("\x1b");
  await directClosed;

  await h.tools.get("task_cancel").execute("c1", { id: daemonId }, undefined, undefined, h.ctx);
});

test("createDispatchExtension validates agentsDirs eagerly and default renderers render cleanly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-eager-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir);
  writeFileSync(join(agentsDir, "bad.md"), "---\nname: bad\ndescription: x\nunknownField: 123\n---\nprompt\n");

  assert.throws(
    () => createDispatchExtension({ agentsDirs: { global: agentsDir } }),
    /unknown field "unknownField"/,
  );

  const h = makeHarness(t);
  const taskTool = h.tools.get("task");
  assert.ok(taskTool.renderCall);
  assert.ok(taskTool.renderResult);
  const callView = taskTool.renderCall({ name: "reviewer", task: "audit changes" }, plainTheme, {}).render(80).join("\n");
  assert.match(callView, /task.*@reviewer audit changes/);
  const notifyView = h.notifyRenderer({ content: "[SYSTEM NOTIFICATION - NOT USER INPUT] Auto\njob_123 completed: ok" }, { expanded: false }, plainTheme).render(80).join("\n");
  assert.doesNotMatch(notifyView, /SYSTEM NOTIFICATION/);
  assert.match(notifyView, /job_123 completed: ok/);
});
