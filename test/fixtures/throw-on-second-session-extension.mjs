// Fails to register its provider on the second (and only the second) time this factory runs,
// simulating a session-replacing call (/new, /resume, /fork) whose runtime factory throws only
// after AgentSessionRuntime already tore down the current session -- a failure with nothing left to
// recover into (bug 7's fatal path). The first invocation (the initial session) registers nothing
// and succeeds; a later invocation (any rebuild of AgentSessionServices re-runs every extension
// factory) calls registerProvider with a config that fails validation, which agent-session-services.js
// turns into an "error" diagnostic that services.ts's createRuntime then throws on.
import { existsSync, writeFileSync } from "node:fs";

export default function (pi) {
  const markerPath = process.env.MMP_TEST_SECOND_SESSION_MARKER;
  if (existsSync(markerPath)) {
    // validateExtensionProvider (provider-composer.js) rejects streamSimple without api synchronously.
    pi.registerProvider("boom-provider", { streamSimple: () => {} });
    return;
  }
  writeFileSync(markerPath, "1");
}
