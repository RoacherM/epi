// A dispatch runtime mounted on the fake Pi API with its state in a temp dir, for offline tests.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DispatchRuntime } from "../../dist/extensions/dispatch/runtime.js";
import { createFakePi } from "./dispatch-fake-pi.mjs";
import { removeTempDir } from "./temp-dir.mjs";

export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => removeTempDir(dir));
  return dir;
}

export async function mountRuntime(t, { role = "root", host = {}, worker, sessionId = "sess-1", mode = "tui", stateDir, branch } = {}) {
  const root = stateDir ?? tempDir(t, "dispatch-rt-");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const runtime = new DispatchRuntime({ stateDir: join(root, "state"), ...host }, role, worker);
  const fake = createFakePi({ sessionId, mode, branch });
  fake.ctx.cwd = root;
  runtime.mount(fake.pi);
  await fake.emit("session_start", { reason: "startup" });
  t.after(async () => {
    await runtime.shutdown();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  });
  const call = (name, params, signal) => fake.tools.get(name).execute(`call-${Math.random()}`, params, signal, undefined, fake.ctx);
  return { runtime, fake, root, stateDir: join(root, "state"), call };
}

export function resultText(result) {
  return result.content.map((part) => part.text ?? "").join("");
}
