// Runs MMP's SDK path (src/tui) without a terminal, for startup-contract tests. It assembles the
// Manifest exactly like `mmp` does, then builds the session the way the new interactive host will.
// Usage: MMP_SDK_RUNNER='<json {prompt?}>' node sdk-path-runner.mjs   (MMP_HOME/HOME set by caller)
import { prepareMmpRun } from "../../dist/host.js";
import { createRuntimeFromPrepared } from "../../dist/tui/start.js";

const options = JSON.parse(process.env.MMP_SDK_RUNNER ?? "{}");
const runtime = await createRuntimeFromPrepared(prepareMmpRun(["--no-project"]), process.cwd());
await runtime.session.bindExtensions({ mode: "print" });
// bindExtensions re-registers extension providers, which starts another un-awaited auth refresh.
await runtime.services.modelRuntime.refresh({ allowNetwork: false });
if (options.prompt !== undefined) {
  await runtime.session.prompt(options.prompt);
  process.stdout.write(`${runtime.session.getLastAssistantText() ?? ""}\n`);
}
await runtime.dispose();
