// Runs Epi's SDK path (src/tui) without a terminal, for startup-contract tests. It assembles the
// Manifest exactly like `epi` does, then builds the session the way the new interactive host will.
// Usage: EPI_SDK_RUNNER='<json {args?, prompt?, dumpTools?}>' node sdk-path-runner.mjs
// (EPI_HOME/HOME set by caller). `args` replaces the default `--no-project` entirely (not appended
// to it), so tests that need real project discovery (e.g. --approve) can pass their own.
// First, like dist/cli.js: EPI_* -> PI_* before any Pi module loads (src/pi-env.ts).
import "../../dist/isolate-pi-env.js";
import { EpiPreflightError } from "../../dist/errors.js";
import { prepareEpiRun } from "../../dist/host.js";
import { createRuntimeFromPrepared } from "../../dist/tui/start.js";

const options = JSON.parse(process.env.EPI_SDK_RUNNER ?? "{}");

try {
  const runtime = await createRuntimeFromPrepared(prepareEpiRun(options.args ?? ["--no-project"]), process.cwd());
  await runtime.session.bindExtensions({ mode: "print" });
  // bindExtensions re-registers extension providers, which starts another un-awaited auth refresh.
  await runtime.services.modelRuntime.refresh({ allowNetwork: false });
  if (options.dumpTools === true) {
    process.stdout.write(`${JSON.stringify(runtime.session.getActiveToolNames())}\n`);
  }
  if (options.dumpCwd === true) {
    process.stdout.write(`${JSON.stringify({ runtimeCwd: runtime.cwd, sessionCwd: runtime.session.sessionManager.getCwd() })}\n`);
  }
  if (options.dumpDiagnostics === true) {
    process.stdout.write(`${JSON.stringify(runtime.diagnostics)}\n`);
  }
  if (options.dumpModel === true) {
    process.stdout.write(`${JSON.stringify({ model: runtime.session.model, thinkingLevel: runtime.session.thinkingLevel })}\n`);
  }
  if (options.prompt !== undefined) {
    await runtime.session.prompt(options.prompt);
    process.stdout.write(`${runtime.session.getLastAssistantText() ?? ""}\n`);
  }
  await runtime.dispose();
} catch (error) {
  process.stderr.write(`epi: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof EpiPreflightError ? error.exitCode : 1;
}
