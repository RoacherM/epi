// Offline trace feasibility probe. No provider, user config or credentials are read.
// Run: node scripts/probes/trace-contract.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const scratch = mkdtempSync(join(tmpdir(), 'epi-trace-probe-'));
// Set before dynamic SDK imports, which resolve some paths at module load.
process.env.HOME = join(scratch, 'home');
process.env.EPI_HOME = join(scratch, 'epi');
process.env.PI_CODING_AGENT_DIR = join(scratch, 'epi', 'pi');
process.env.PI_OFFLINE = '1';
mkdirSync(process.env.HOME, { recursive: true });

try {
  const { runAgentLoop } = await import('@earendil-works/pi-agent-core');
  const { createAssistantMessageEventStream, getCurrentTools } = await import('@earendil-works/pi-ai');
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const usage = { input: 10, output: 7, reasoning: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const model = { id: 'offline', name: 'offline', api: 'probe', provider: 'probe', input: ['text'],
    reasoning: true, contextWindow: 10000, maxTokens: 1000, cost: usage.cost };
  const actual = new Map();
  const events = [];
  const manager = SessionManager.inMemory(scratch);
  const tools = ['fast', 'slow', 'blocked'].map((name) => ({ name, label: name, description: name,
    parameters: { type: 'object', properties: {} },
    async execute() {
      assert.notEqual(name, 'blocked');
      const start = Date.now();
      await delay(name === 'fast' ? 15 : 160);
      actual.set(name, { start, end: Date.now() });
      return { content: [{ type: 'text', text: name }], details: {} };
    },
  }));
  let round = 0;
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    const first = round++ === 0;
    const base = { role: 'assistant', content: [], provider: 'probe', api: 'probe', model: 'offline',
      usage, timestamp: Date.now(), stopReason: 'pending' };
    queueMicrotask(async () => {
      stream.push({ type: 'start', partial: base });
      await delay(10);
      const message = { ...base, content: first
        ? tools.map((t) => ({ type: 'toolCall', id: t.name, name: t.name, arguments: {} }))
        : [{ type: 'text', text: 'finished' }], stopReason: first ? 'toolUse' : 'stop' };
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  await runAgentLoop([{ role: 'user', content: 'probe', timestamp: Date.now() }],
    { messages: [], tools }, {
      model, convertToLlm: (m) => m, toolExecution: 'parallel',
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.name === 'blocked') return { block: true, reason: 'probe denied' };
      },
      afterToolCall: async ({ toolCall }) => { if (toolCall.name === 'fast') await delay(40); },
    }, (e) => {
      events.push({ type: e.type, id: e.toolCallId, at: Date.now(), durationMs: e.durationMs });
      if (e.type === 'message_end') manager.appendMessage(e.message);
    }, undefined, streamFn);

  const entries = manager.getBranch();
  const results = entries.filter((e) => e.message?.role === 'toolResult').map((e) => e.message);
  const fast = results.find((m) => m.toolName === 'fast');
  const slow = results.find((m) => m.toolName === 'slow');
  const blocked = results.find((m) => m.toolName === 'blocked');
  const fastEnd = events.find((e) => e.type === 'tool_execution_end' && e.id === 'fast');
  const slowEnd = events.find((e) => e.type === 'tool_execution_end' && e.id === 'slow');
  assert.ok(fastEnd.at < slowEnd.at, 'events retain completion order');
  assert.ok(fast.timestamp >= actual.get('slow').end, 'fast result persisted only after slow finished');
  assert.ok(fast.timestamp - fast.durationMs > actual.get('fast').start + 50,
    'end timestamp minus duration is NOT a valid execution start');
  assert.ok(fastEnd.at - actual.get('fast').end >= 30, 'end event includes afterToolCall delay');
  assert.equal(blocked.isError, true);
  assert.equal(blocked.durationMs, undefined, 'preflight rejection has no execution duration');
  assert.ok(entries.filter((e) => e.message?.role === 'assistant').every((e) => e.message.durationMs >= 0));
  assert.deepEqual(results.map((m) => m.toolName), ['fast', 'slow', 'blocked']);

  // System declarations persist schemas. Replaying changes must be branch-relative.
  const messages = entries.filter((e) => e.type === 'message').map((e) => e.message);
  assert.equal(getCurrentTools(messages).length, 3);
  const anchor = manager.getLeafId();
  manager.appendMessage({ role: 'system', content: '', timestamp: Date.now(),
    toolsRemoved: [{ name: 'fast' }], toolsAdded: [{ name: 'slow', description: 'new schema',
      parameters: { type: 'object', properties: { changed: { type: 'boolean' } } } }] });
  const changed = getCurrentTools(manager.getBranch().filter((e) => e.type === 'message').map((e) => e.message));
  assert.equal(changed.some((t) => t.name === 'fast'), false);
  assert.ok(changed.find((t) => t.name === 'slow').parameters.properties.changed);
  manager.branch(anchor);
  assert.equal(getCurrentTools(manager.getBranch().filter((e) => e.type === 'message').map((e) => e.message)).length, 3);

  // Compaction changes model context, not the raw branch needed for a trace.
  const before = manager.getBranch().length;
  const keep = manager.getLeafId();
  manager.appendCompaction('probe summary', keep, 100);
  assert.equal(manager.getBranch().length, before + 1);
  assert.ok(manager.buildContextEntries().length < manager.getBranch().length);
  const bytesBefore = JSON.stringify(manager.buildSessionContext().messages);
  manager.appendCustomEntry('epi.trace.probe', { toolCallId: 'fast', observed: fastEnd.at });
  assert.equal(JSON.stringify(manager.buildSessionContext().messages), bytesBefore,
    'custom observation entries do not alter model context');
  const observedLeaf = manager.getLeafId();
  manager.branch(keep);
  assert.ok(manager.getBranch().some((e) => e.id === keep));
  assert.ok(!manager.getBranch().some((e) => e.id === observedLeaf),
    'forking before the observation retains the message but loses its later metadata');

  console.log(JSON.stringify({
    versions: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).dependencies,
    checks: 'parallel completion vs persistence; hook timing; blocked duration; model duration; schema delta; branch; compaction; non-context metadata; metadata reachability after branch: PASS',
    toolTiming: results.map((m) => ({ name: m.toolName, durationMs: m.durationMs ?? null,
      resultCreatedAt: m.timestamp, actual: actual.get(m.toolName) ?? null,
      observedEnd: events.find((e) => e.type === 'tool_execution_end' && e.id === m.toolCallId)?.at })),
    historicalSchemas: getCurrentTools(messages).map((t) => t.name),
  }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
