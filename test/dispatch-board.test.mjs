// Stage 2 of docs/dispatch-design.md: named tasks as board peers. board_post + board_wait keep
// FIFO order in one turn; board_wait wakes on an @mention (checked before parking), a parent steer
// or the abort/idle cap; peers hand off without the coordinator relaying; isolated workspaces with
// work in them survive task_cancel unless forceDirty; the stall detector fires once per board
// state; forkFrom seeds a peer from a sibling's history. Offline: real fd 3 workers on a faux model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BoardHub, createBoardTools, parseMentions, PeerBoard } from "../dist/extensions/dispatch/board.js";
import { waitFor } from "./helpers/dispatch-fake-pi.mjs";
import { mountRuntime, resultText, tempDir } from "./helpers/dispatch-runtime.mjs";

const faux = fileURLToPath(new URL("./fixtures/dispatch-faux-task.mjs", import.meta.url));
const MODEL = "epi-faux/tools";

function peerFixture(t, { idleMs = 60_000 } = {}) {
  const dir = tempDir(t, "dispatch-peer-");
  const hub = new BoardHub({ stateDir: () => dir, onPosted: () => {} });
  hub.bind("sess-1");
  const emitted = [];
  const board = new PeerBoard({ name: "beta", path: hub.path, emit: (event) => emitted.push(event), finite: () => 0, idleMs });
  let idled = 0;
  const tools = Object.fromEntries(createBoardTools({
    self: "beta", post: (text, channel) => { board.post(text, channel); return undefined; },
    read: (options) => board.read(options), wait: (since, only, signal) => board.wait(since, only, signal), onIdle: () => { idled += 1; },
  }).map((tool) => [tool.name, tool]));
  const run = (name, params, signal) => tools[name].execute("c", params, signal, undefined, {});
  return { hub, board, emitted, run, idled: () => idled };
}

test("mentions parse @name and @all, not e-mail addresses", () => {
  assert.deepEqual(parseMentions("@beta take this, cc @all; mail me@host.com"), ["beta", "all"]);
});

test("board_post then board_wait in one turn: the post is on fd 3 before the wait parks (FIFO)", async (t) => {
  const { run, emitted, board, hub } = peerFixture(t);
  const posting = run("board_post", { text: "@alpha ready for review" });
  const waiting = run("board_wait", { since: 0 });
  assert.deepEqual(emitted.map((event) => event.type), ["board_post", "state"], "post written synchronously, before the wait's park");
  assert.equal(emitted[1].parked, true);
  await posting;
  board.onPush(hub.post("alpha", "@beta looks good"));
  const result = resultText(await waiting);
  assert.match(result, /#1 \[general\] @alpha: @beta looks good/);
  assert.equal(emitted.at(-1).parked, false);
});

test("board_wait: a matching message already on the board returns before parking", async (t) => {
  const { run, emitted, hub } = peerFixture(t);
  hub.post("coordinator", "@beta brief");
  hub.post("alpha", "@beta handoff A");
  hub.post("alpha", "@gamma not for beta");
  const result = resultText(await run("board_wait", { since: 1 }));
  assert.match(result, /@alpha: @beta handoff A/);
  assert.doesNotMatch(result, /brief|gamma/);
  assert.deepEqual(emitted, [], "never parked");
  assert.match(resultText(await run("board_wait", { since: 0, mentions_only: false })), /gamma/);
});

test("board_wait wakes on a parent steer, on abort, and on the idle cap (which ends the run)", async (t) => {
  const { run, board, idled } = peerFixture(t, { idleMs: 150 });
  const steered = run("board_wait", { since: 0 });
  board.wake("steer");
  assert.match(resultText(await steered), /new instruction from your parent/);
  const controller = new AbortController();
  const aborted = run("board_wait", { since: 0 }, controller.signal);
  controller.abort();
  assert.equal((await aborted).details.reason, "aborted");
  const idle = await run("board_wait", { since: 0 });
  assert.equal(idle.details.reason, "idle");
  assert.equal(idled(), 1);
  const notified = run("board_wait", { since: 0 });
  board.wake("notification");
  assert.equal((await notified).details.reason, "notification");
});

async function rootFixture(t, host = {}) {
  const fixture = await mountRuntime(t, { host: { workerExtensionPaths: [faux], ...host } });
  const startPeer = async (name, task, extra = {}) => {
    const result = await fixture.call("task", { name, task, model: MODEL, ...extra });
    assert.match(resultText(result), /started in the background/, resultText(result));
    return fixture.runtime.pool.resolve(name);
  };
  return { ...fixture, startPeer };
}

test("two named peers hand off @beta -> beta directly; the coordinator only posted the briefs", async (t) => {
  const { runtime, startPeer, fake } = await rootFixture(t);
  const beta = await startPeer("beta", "peer-beta wait for alpha");
  const alpha = await startPeer("alpha", "peer-alpha hand off to beta");
  const [betaDone, alphaDone] = await Promise.all([runtime.pool.wait(beta), runtime.pool.wait(alpha)]);
  assert.equal(betaDone.status, "completed", betaDone.error);
  assert.match(betaDone.result, /BETA-GOT-HANDOFF/);
  assert.match(alphaDone.result, /ALPHA-DONE/);
  const board = readFileSync(runtime.board.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(board.map((m) => [m.seq, m.sender, m.mentions]), [[1, "coordinator", ["beta"]], [2, "coordinator", ["alpha"]], [3, "alpha", ["beta"]]]);
  await waitFor(() => fake.sent.length >= 1, { label: "settle notices" });
  assert.ok(fake.sent.every((s) => !/HANDOFF-FROM-ALPHA payload/.test(s.message.content) || /beta|alpha/.test(s.message.content)));
  assert.equal(board.filter((m) => m.sender === "coordinator").length, 2, "no relay by the coordinator");
});

test("the stall detector fires once when every live peer is parked, and a post unblocks them", async (t) => {
  const { runtime, startPeer, fake, call } = await rootFixture(t);
  const p1 = await startPeer("p1", "peer-idle waits");
  const p2 = await startPeer("p2", "peer-idle waits too");
  await waitFor(() => fake.sent.some((s) => s.message.content.includes("[board stall]")), { timeoutMs: 10_000, label: "stall notice" });
  const stall = fake.sent.find((s) => s.message.content.includes("[board stall]")).message;
  assert.match(stall.content, /@p1, @p2|@p2, @p1/);
  runtime.checkStall();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fake.sent.filter((s) => s.message.content.includes("[board stall]")).length, 1, "one notice per stall:<epoch>:<maxSeq>");
  await call("board_post", { text: "@p1 @p2 wake up" });
  const [d1, d2] = await Promise.all([runtime.pool.wait(p1), runtime.pool.wait(p2)]);
  assert.match(d1.result, /IDLE-PEER-WOKE: .*@coordinator: @p1 @p2 wake up/);
  assert.match(d2.result, /IDLE-PEER-WOKE/);
});

test("the idle cap settles a peer as partial; an @mention resumes it in place", async (t) => {
  const { runtime, startPeer, call } = await rootFixture(t, { boardIdleMs: 300 });
  const id = await startPeer("p3", "peer-idle naps");
  const idle = await runtime.pool.wait(id);
  assert.equal(idle.status, "partial", idle.error);
  assert.equal(idle.stoppedBy, "idle");
  await call("board_post", { text: "@p3 come back please" });
  await waitFor(() => runtime.pool.status(id).status === "running" || runtime.pool.status(id).run === 2, { label: "revival" });
  const revived = await runtime.pool.wait(id);
  assert.equal(revived.run, 2);
  assert.match(revived.result, /REVIVED: Board message #2 from @coordinator: @p3 come back please/);
});

test("forkFrom seeds a new peer with a sibling's history", async (t) => {
  const { runtime, startPeer } = await rootFixture(t);
  const alpha = await startPeer("alpha", "peer-alpha with history");
  await runtime.pool.wait(alpha);
  const fork = await startPeer("alpha2", "peer-fork continue alpha", { forkFrom: "alpha" });
  const done = await runtime.pool.wait(fork);
  assert.equal(done.status, "completed", done.error);
  assert.match(done.result, /FORK-SAW-ALPHA/);
});

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

for (const mode of ["share", "branch"]) {
  test(`task_cancel keeps a dirty ${mode} workspace unless forceDirty, and removes a clean one`, async (t) => {
    const { runtime, call, root } = await rootFixture(t);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const start = () => runtime.pool.start({ task: "child-simple in a workspace", cwd: repo, workspace: mode, inheritedModel: MODEL });
    const dirty = await runtime.pool.wait(start().id);
    assert.equal(dirty.status, "completed", dirty.error);
    writeFileSync(join(dirty.workspace.path, "work.txt"), "unmerged work\n");
    const kept = resultText(await call("task_cancel", { id: dirty.id }));
    assert.match(kept, /Workspace kept at .* because it holds work \(.*\); task_cancel\(\{ id: ".*", forceDirty: true \}\) deletes it/);
    assert.ok(existsSync(join(dirty.workspace.path, "work.txt")));
    const forced = resultText(await call("task_cancel", { id: dirty.id, forceDirty: true }));
    assert.match(forced, new RegExp(`workspace \\(${mode}\\) removed`));
    assert.equal(existsSync(dirty.workspace.path), false);
    const clean = await runtime.pool.wait(start().id);
    assert.match(resultText(await call("task_cancel", { id: clean.id })), /removed/);
    if (mode === "branch") assert.doesNotMatch(git(repo, "branch", "--list"), /dispatch\//, "branches are dropped with their worktrees");
  });
}
