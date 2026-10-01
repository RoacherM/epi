// Preloaded with `node --import`: appends to $MMP_TEST_MODULE_LOG the URL of every module loaded
// whose URL contains $MMP_TEST_MODULE_MATCH. Synchronous hooks, so both import() and require()
// of an ES module are seen.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const logPath = process.env.MMP_TEST_MODULE_LOG;
const match = process.env.MMP_TEST_MODULE_MATCH;

registerHooks({
  load(url, context, nextLoad) {
    if (logPath && match && url.includes(match)) appendFileSync(logPath, `${url}\n`);
    return nextLoad(url, context);
  },
});
