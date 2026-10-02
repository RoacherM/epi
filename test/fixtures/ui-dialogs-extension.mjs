// Exercises the extension UI host's editor-slot dialogs: confirm, input, editor, and the
// abort/timeout options of select and confirm.
export default function (pi) {
  const probe = (name, ask) => pi.registerCommand(name, {
    description: `${name} dialog probe`,
    handler: async (_args, ctx) => {
      const result = await ask(ctx.ui);
      ctx.ui.notify(`${name} result: ${JSON.stringify(result)}`, "info");
    },
  });
  probe("ask-confirm", (ui) => ui.confirm("CONFIRM-TITLE", "CONFIRM-MESSAGE"));
  probe("ask-input", (ui) => ui.input("INPUT-TITLE", "INPUT-PLACEHOLDER"));
  probe("ask-editor", (ui) => ui.editor("EDITOR-TITLE", "EDITOR-PREFILL"));
  probe("ask-timeout", (ui) => ui.confirm("TIMEOUT-TITLE", "closes by itself", { timeout: 300 }));
  probe("ask-abort", (ui) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    return ui.select("ABORT-TITLE", ["one", "two"], { signal: controller.signal });
  });
  probe("ask-preaborted", (ui) => ui.select("PREABORTED-TITLE", ["one", "two"], { signal: AbortSignal.abort() }));
}
