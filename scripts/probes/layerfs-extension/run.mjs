// THROWAWAY: real Pi runtime + fake in-memory workspace + scripted faux provider.
// Run: node scripts/probes/layerfs-extension/run.mjs
// No LayerFS/Docker, real model, user configuration or real shell commands.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'epi-layerfs-extension-probe-'));
const cwd = join(scratch, 'project');
const checks = [];
const sessions = [];
process.env.HOME = join(scratch, 'home');
process.env.EPI_HOME = join(scratch, 'epi');
process.env.PI_CODING_AGENT_DIR = join(process.env.EPI_HOME, 'pi');
process.env.PI_OFFLINE = '1';
process.env.EPI_OFFLINE = '1';
process.env.EPI_NETWORK_GUARD_OUT = join(scratch, 'network.log');
mkdirSync(cwd, { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(join(cwd, 'file.txt'), 'HOST_ONLY\n');
writeFileSync(process.env.EPI_NETWORK_GUARD_OUT, '');

function passed(name, evidence) { checks.push({ name, status: 'PASS', evidence }); }
function text(result) { return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'); }
function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`probe timed out: ${label}`)), 5000); }),
  ]).finally(() => clearTimeout(timer));
}

function fakeWorkspace() {
  const files = new Map([['file.txt', 'REMOTE one two\n']]);
  let saved = JSON.stringify([...files]);
  let revision = 0;
  const state = { closed: 0, aborted: false, failCheckpoint: false, started: null, release: null };
  const key = (path) => {
    const rel = relative(cwd, resolve(path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('outside probe workspace');
    return rel;
  };
  return {
    cwd, files, state,
    read: {
      async readFile(path) {
        const name = key(path);
        if (!files.has(name)) throw new Error(`not found: ${name}`);
        return Buffer.from(files.get(name));
      },
      async access(path) { if (!files.has(key(path))) throw new Error('not found'); },
      async detectImageMimeType() { return null; },
    },
    write: {
      async mkdir(path) { key(path); },
      async writeFile(path, content) { files.set(key(path), content); },
    },
    bash: {
      async exec(command, _cwd, { onData, signal }) {
        signal?.throwIfAborted();
        if (command === 'probe-stream') {
          onData(Buffer.from('FIRST_CHUNK\n'));
          state.started.resolve();
          await state.release.promise;
          onData(Buffer.from('LAST_CHUNK\n'));
          files.set('shell.txt', 'from fake shell\n');
          return { exitCode: 0 };
        }
        if (command === 'probe-wait') {
          state.started.resolve();
          await new Promise((_, reject) => {
            const abort = () => { state.aborted = true; reject(new Error('probe backend aborted')); };
            if (signal?.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        if (command === 'probe-fail') {
          files.set('failed-output.txt', 'partial work remains\n');
          onData(Buffer.from('EXPECTED_FAILURE\n'));
          return { exitCode: 7 };
        }
        if (command === 'probe-user') {
          files.set('user.txt', 'user shell\n');
          onData(Buffer.from('USER_BASH_ROUTED\n'));
          return { exitCode: 0 };
        }
        throw new Error(`not a real shell: ${command}`);
      },
    },
    async checkpoint() {
      if (state.failCheckpoint) throw new Error('CHECKPOINT_UNAVAILABLE');
      const current = JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)));
      if (current === saved) return undefined;
      const previous = new Map(JSON.parse(saved));
      const changedPaths = [...new Set([...previous.keys(), ...files.keys()])]
        .filter((path) => previous.get(path) !== files.get(path)).sort();
      const before = `fake-${revision}`;
      saved = current;
      return { before, after: `fake-${++revision}`, backend: 'FAKE', changedPaths };
    },
    async close() { state.closed++; },
  };
}

try {
  await import('../../../test/fixtures/network-guard.mjs');
  const { fauxAssistantMessage, fauxText, fauxToolCall } = await import('@earendil-works/pi-ai');
  const { createAgentSessionServices, createAgentSessionFromServices, resolveCliModel, SessionManager, SettingsManager } =
    await import('@earendil-works/pi-coding-agent');
  const { registerFaux } = await import('../../../test/fixtures/faux-register.mjs');
  const { workspaceExtension, ENTRY } = await import('./extension.mjs');
  const backend = fakeWorkspace();
  const observedCalls = [];
  const extensionErrors = [];

  async function makeSession(withWorkspace) {
    let pending = [];
    const provider = (pi) => registerFaux(pi, {
      models: ['layerfs-probe'],
      responses: Array.from({ length: 60 }, () => () => {
        if (pending.length === 0) return fauxAssistantMessage(fauxText('probe complete'));
        const calls = pending;
        pending = [];
        return fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: 'toolUse' });
      }),
    });
    const observer = (pi) => pi.on('tool_call', (event) => {
      observedCalls.push({ id: event.toolCallId, name: event.toolName });
      if (event.input.path === 'blocked.txt') return { block: true, reason: 'PROBE_POLICY_DENIED' };
    });
    const services = await createAgentSessionServices({
      cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: '', appendSystemPrompt: [],
        extensionFactories: [provider, observer, ...(withWorkspace ? [workspaceExtension(backend)] : [])],
      },
    });
    assert.deepEqual(services.diagnostics.filter((d) => d.type === 'error'), []);
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const { model } = resolveCliModel({ cliModel: 'epi-faux/layerfs-probe', modelRuntime: services.modelRuntime });
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({
      services, model, thinkingLevel: 'off', sessionManager: SessionManager.inMemory(cwd),
      tools: ['read', 'write', 'edit', 'bash'],
    });
    sessions.push(session);
    session.extensionRunner.onError((error) => extensionErrors.push(error));
    await session.bindExtensions({ mode: 'print' });
    return {
      session,
      async run(calls) {
        const before = session.messages.length;
        pending = calls;
        await session.prompt('Run the offline scripted probe.');
        return session.messages.slice(before).filter((m) => m.role === 'toolResult');
      },
    };
  }

  const { session, run } = await makeSession(true);
  const checkpoints = () => session.sessionManager.getBranch().filter((e) => e.type === 'custom' && e.customType === ENTRY);
  assert.ok(session.extensionRunner.getCommand('layerfs-probe'));
  for (const name of ['read', 'write', 'edit', 'bash']) {
    assert.equal(session.getAllTools().filter((t) => t.name === name).length, 1);
  }
  let [result] = await run([['read', { path: 'file.txt' }]]);
  assert.equal(result.isError, false);
  assert.match(text(result), /REMOTE one two/);
  assert.equal(checkpoints().length, 0);
  passed('extension registration and built-in override', 'One tool per name; read returns fake workspace, not HOST_ONLY.');

  [result] = await run([['write', { path: 'file.txt', content: 'REMOTE one two\n' }]]);
  assert.equal(result.isError, false);
  assert.equal(checkpoints().length, 0);
  passed('no-op mutation', 'No invented checkpoint when file state is unchanged.');

  const results = await run([
    ['write', { path: 'file.txt', content: 'one two\n' }],
    ['edit', { path: 'file.txt', edits: [
      { oldText: 'one', newText: 'ONE' }, { oldText: 'two', newText: 'TWO' },
    ] }],
  ]);
  assert.ok(results.every((r) => !r.isError));
  assert.equal(backend.files.get('file.txt'), 'ONE TWO\n');
  assert.equal(checkpoints().length, 2);
  assert.deepEqual(checkpoints().map((e) => e.data.toolCallId), results.map((r) => r.toolCallId));
  assert.ok(checkpoints().every((e) => observedCalls.some((c) => c.id === e.data.toolCallId)));
  passed('Pi batch edit + tool/checkpoint attribution', 'Two tools in one response; two serialized checkpoints; exact toolCallIds.');

  const updates = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'tool_execution_update') updates.push(event);
  });
  backend.state.started = Promise.withResolvers();
  backend.state.release = Promise.withResolvers();
  const streaming = run([['bash', { command: 'probe-stream' }]]);
  try {
    await bounded(backend.state.started.promise, 'stream start');
    assert.ok(updates.some((e) => text(e.partialResult).includes('FIRST_CHUNK')));
  } finally {
    backend.state.release.resolve();
    await streaming;
    unsubscribe();
  }
  assert.equal(checkpoints().length, 3);
  passed('BashOperations streaming seam', 'Pi emits tool update before fake executor completes; real LayerFS streaming NOT tested.');

  [result] = await run([['bash', { command: 'probe-fail' }]]);
  assert.equal(result.isError, true);
  assert.equal(backend.files.get('failed-output.txt'), 'partial work remains\n');
  assert.equal(checkpoints().length, 4);
  passed('nonzero shell with writes', 'Exit 7 stays an error; partial file changes are retained and checkpointed.');

  const beforeDenied = checkpoints().length;
  [result] = await run([['write', { path: 'blocked.txt', content: 'no' }]]);
  assert.equal(result.isError, true);
  assert.match(text(result), /PROBE_POLICY_DENIED/);
  assert.equal(backend.files.has('blocked.txt'), false);
  [result] = await run([['write', { path: '../escape.txt', content: 'no' }]]);
  assert.equal(result.isError, true);
  assert.equal(checkpoints().length, beforeDenied);
  passed('hooks and lexical path refusal', 'Blocked and out-of-root writes never reached fake state; symlinks NOT tested.');

  backend.state.failCheckpoint = true;
  [result] = await run([['write', { path: 'pending.txt', content: 'not saved' }]]);
  backend.state.failCheckpoint = false;
  assert.equal(result.isError, true);
  assert.match(text(result), /CHECKPOINT_UNAVAILABLE/);
  assert.equal(checkpoints().length, beforeDenied);
  assert.equal(backend.files.get('pending.txt'), 'not saved');
  passed('checkpoint failure visibility', 'Tool reports error, no fake receipt; mutation remains pending (no automatic rollback).');

  backend.state.started = Promise.withResolvers();
  const aborted = run([['bash', { command: 'probe-wait' }]]);
  try {
    await bounded(backend.state.started.promise, 'abort start');
  } finally {
    await bounded(session.abort(), 'session abort');
    await bounded(aborted, 'aborted prompt');
  }
  assert.equal(backend.state.aborted, true);
  assert.equal(checkpoints().length, beforeDenied);
  passed('AbortSignal propagation', 'session.abort reaches fake executor; Docker process-tree cancellation NOT tested.');

  const command = 'probe-user';
  const routed = await session.extensionRunner.emitUserBash({ type: 'user_bash', command, cwd, excludeFromContext: false });
  assert.ok(routed.operations);
  const userResult = await session.executeBash(command, undefined, { operations: routed.operations });
  assert.equal(userResult.exitCode, 0);
  assert.match(userResult.output, /USER_BASH_ROUTED/);
  assert.equal(checkpoints().at(-1).data.source, 'user_bash');
  assert.deepEqual(checkpoints().at(-1).data.changedPaths, ['pending.txt', 'user.txt']);
  passed('user_bash routing and pending-write contamination',
    'Route works, but naive next checkpoint captures both pending.txt and user.txt: attribution needs a recovery gate.');

  const count = checkpoints().length;
  assert.ok(!JSON.stringify(session.sessionManager.buildSessionContext().messages).includes(ENTRY));
  const checkpointAnchor = checkpoints()[0].id;
  session.sessionManager.branch(checkpointAnchor);
  assert.equal(checkpoints().length, 1);
  assert.equal(backend.files.get('file.txt'), 'ONE TWO\n');
  passed('branch-relative metadata is not filesystem rollback', `${count} non-context receipts; branch navigation hides later receipts but does not rewind backend.`);

  const child = await makeSession(false);
  [result] = await child.run([['read', { path: 'file.txt' }]]);
  assert.match(text(result), /HOST_ONLY/);
  assert.equal(child.session.extensionRunner.getCommand('layerfs-probe'), undefined);
  passed('fresh session does not inherit parent extension', 'Unextended session uses local read; Epi task worker process NOT exercised.');

  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.equal(backend.state.closed, 1);
  assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'HOST_ONLY\n');
  assert.deepEqual(extensionErrors, []);
  assert.equal(readFileSync(process.env.EPI_NETWORK_GUARD_OUT, 'utf8'), '');
  passed('idempotent extension teardown and host untouched', 'Explicit shutdown event twice closes once; no network attempts; original file unchanged.');

  console.log(JSON.stringify({
    probe: 'Pi extension feasibility, NOT LayerFS integration',
    pi: JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).dependencies['@earendil-works/pi-coding-agent'],
    checks,
    designBlocker: 'After checkpoint failure, block further mutations or explicitly track pending origins; a successful later commit is not attributable solely to its latest tool call.',
    notTested: [
      'LayerFS native/Store/FUSE/Docker and crash durability',
      'remote process kill, timeout, binary output, image reads and symlinks',
      'Epi Manifest loading, real task worker, Review/Trace UI integration',
      'restart recovery, session-fork filesystem policy and disk-persisted receipts',
    ],
  }, null, 2));
} finally {
  for (const session of sessions) {
    await session.abort();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
  rmSync(scratch, { recursive: true, force: true });
}
