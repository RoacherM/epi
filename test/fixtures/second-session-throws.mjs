// `node --import` hook for test/tui-fatal-errors.test.mjs: Pi's createAgentSessionFromServices
// works for the initial session and throws on the second (and later) call, simulating a
// session-replacing call (/new, /import) whose runtime factory throws only after AgentSessionRuntime
// already tore down the current session -- a failure with nothing left to recover into (bug 7's
// fatal path). An error diagnostic can't simulate this: on a replacement those are shown and the
// session goes on, like Pi (dogfood D51). Test only: matches Pi's package entry by path, so if Pi
// moves it (or services.ts stops importing it) the hook stops applying and the tests fail on the
// missing error line.
import { registerHooks } from "node:module";

const TAG = "?epi-second-session-throws";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    // Only Epi's runtime factory's import. The URL stays a file: URL (services.ts also passes Pi's
    // resolved entry to fileURLToPath); the load hook below swaps in the wrapper for it.
    if (!/\/dist\/tui\/services\.js$/.test(context.parentURL ?? "")) return result;
    if (!/\/pi-coding-agent\/dist\/index\.js$/.test(result.url)) return result;
    return { ...result, url: `${result.url}${TAG}` };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(TAG)) return nextLoad(url, context);
    const real = JSON.stringify(url.slice(0, -TAG.length));
    const source =
      `import * as real from ${real};\n` +
      `export * from ${real};\n` +
      `let calls = 0;\n` +
      `export async function createAgentSessionFromServices(...args) {\n` +
      `  if (++calls > 1) throw new Error("simulated: second session factory failure");\n` +
      `  return real.createAgentSessionFromServices(...args);\n` +
      `}\n`;
    return { format: "module", source, shortCircuit: true };
  },
});
