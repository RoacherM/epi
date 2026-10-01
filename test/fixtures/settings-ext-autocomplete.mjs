// Adds autocomplete providers with ctx.ui.addAutocompleteProvider, the way Pi's extensions do:
// one from session_start (suggests EXTSTART_L<n> for "/zy"), one from the /acadd command
// (EXTCMD_L<n> for "/zz"). Pi keeps both wrappers across autocomplete rebuilds and drops them only
// with the rest of the extension UI (resetExtensionUI, before a session switch and on /reload).
// - L<n> counts stacked copies of a wrapper, so L2 means a leaked or duplicated one.
// - Each wrapper reads the ctx it captured, so an old session's wrapper left on the editor throws
//   Pi's "extension ctx is stale" error (review 2 N1).
// - /slow makes the next session_start take 2 s; /cancelnext makes session_before_switch cancel
//   the next switch.
import echo from "./faux-echo.mjs";

const wrap = (trigger, tag, ctx) => (base) => ({
  ...base,
  triggerCharacters: base.triggerCharacters,
  async getSuggestions(lines, line, col, options) {
    const text = lines[line].slice(0, col);
    if (!text.startsWith(trigger)) return base.getSuggestions(lines, line, col, options);
    void ctx.cwd;
    const inner = await base.getSuggestions(lines, line, col, options);
    const n = (inner?.items ?? []).filter((item) => String(item.description).startsWith(tag)).length + 1;
    return { items: [{ value: `${trigger}ext`, label: `${trigger}ext`, description: `${tag}_L${n}` }], prefix: text };
  },
  applyCompletion: (...args) => base.applyCompletion(...args),
  shouldTriggerFileCompletion: base.shouldTriggerFileCompletion?.bind(base),
});

// On globalThis so the flags outlive the extension reload that /reload and session switches do.
globalThis.__acSlowMs ??= 0;
globalThis.__acCancelNext ??= false;

export default function (pi) {
  echo(pi);
  pi.on("session_start", async (_event, ctx) => {
    const slow = globalThis.__acSlowMs;
    globalThis.__acSlowMs = 0;
    if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
    ctx.ui.addAutocompleteProvider(wrap("/zy", "EXTSTART", ctx));
  });
  pi.on("session_before_switch", () => {
    if (!globalThis.__acCancelNext) return undefined;
    globalThis.__acCancelNext = false;
    return { cancel: true };
  });
  pi.registerCommand("acadd", {
    description: "add an autocomplete provider",
    handler: async (_args, ctx) => ctx.ui.addAutocompleteProvider(wrap("/zz", "EXTCMD", ctx)),
  });
  pi.registerCommand("slow", {
    description: "make the next session_start slow",
    handler: async () => { globalThis.__acSlowMs = 2000; },
  });
  pi.registerCommand("cancelnext", {
    description: "cancel the next session switch",
    handler: async () => { globalThis.__acCancelNext = true; },
  });
}
