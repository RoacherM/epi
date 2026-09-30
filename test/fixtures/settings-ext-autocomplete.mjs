// Adds autocomplete providers with ctx.ui.addAutocompleteProvider, the way Pi's extensions do:
// one from session_start (suggests EXTSTART for "/zy"), one from the /acadd command (EXTCMD for
// "/zz"). Pi keeps both wrappers across autocomplete rebuilds and drops them only with the rest of
// the extension UI (resetExtensionUI, before a session switch and on /reload).
import echo from "./faux-echo.mjs";

const wrap = (trigger, tag) => (base) => ({
  ...base,
  triggerCharacters: base.triggerCharacters,
  async getSuggestions(lines, line, col, options) {
    const text = lines[line].slice(0, col);
    if (text.startsWith(trigger)) return { items: [{ value: `${trigger}ext`, label: `${trigger}ext`, description: tag }], prefix: text };
    return base.getSuggestions(lines, line, col, options);
  },
  applyCompletion: (...args) => base.applyCompletion(...args),
  shouldTriggerFileCompletion: base.shouldTriggerFileCompletion?.bind(base),
});

export default function (pi) {
  echo(pi);
  pi.on("session_start", (_event, ctx) => ctx.ui.addAutocompleteProvider(wrap("/zy", "EXTSTART")));
  pi.registerCommand("acadd", {
    description: "add an autocomplete provider",
    handler: async (_args, ctx) => ctx.ui.addAutocompleteProvider(wrap("/zz", "EXTCMD")),
  });
}
