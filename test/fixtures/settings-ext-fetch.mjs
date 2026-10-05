// Replaces globalThis.fetch in its factory, as an extension that proxies or records requests
// would, and registers /fcheck to report whether Epi kept that override (Pi's
// configureHttpDispatcher keeps it: core/http-dispatcher.js shouldInstallGlobals). Each report is
// numbered across /reload (which re-runs this factory), so a test can tell them apart.
import echo from "./faux-echo.mjs";

globalThis.__epiFetchChecks ??= 0;

export default function (pi) {
  echo(pi);
  const previous = globalThis.fetch;
  const mine = (...args) => previous(...args);
  globalThis.fetch = mine;
  pi.registerCommand("fcheck", {
    description: "report whether the extension's fetch is still installed",
    handler: async (_args, ctx) => {
      globalThis.__epiFetchChecks += 1;
      ctx.ui.notify(`FETCH_OVERRIDE_${globalThis.fetch === mine ? "KEPT" : "LOST"}#${globalThis.__epiFetchChecks}`);
    },
  });
}
