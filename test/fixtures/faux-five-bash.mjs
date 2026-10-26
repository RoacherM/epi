// Faux model that runs five bash commands in one turn, each printing two lines, then reports --
// the shape Ctrl+O per block targets (docs/tui-ctrl-o-per-block-design.md §1: "一轮 5 条 bash").
// `/expandall` and `/collapseall` call the extensions' all-blocks toggle (pi.ui.setToolsExpanded).
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  // The output (`cmd1-out-a`) never appears in the command text (`cmd1 out-a`), so a screen row with it is output.
  const commands = [1, 2, 3, 4, 5].map((n) => `printf '%s-%s\\n' cmd${n} out-a cmd${n} out-b`);
  registerFaux(pi, {
    models: ["tools"],
    responses: [
      ...commands.map((command) => () => fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" })),
      () => fauxAssistantMessage(fauxText("FIVE-DONE")),
      () => fauxAssistantMessage(fauxToolCall("bash", { command: "printf '%s-%s\\n' cmd6 out-a" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("SIX-DONE")),
    ],
  });
  pi.registerCommand("expandall", { description: "test-only: setToolsExpanded(true)", handler: async (_args, ctx) => ctx.ui.setToolsExpanded(true) });
  pi.registerCommand("collapseall", { description: "test-only: setToolsExpanded(false)", handler: async (_args, ctx) => ctx.ui.setToolsExpanded(false) });
}
