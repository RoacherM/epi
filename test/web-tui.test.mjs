// epi:web in the real TUI (docs/web-search-design.md §6): the first-run prompt, a model's search
// through the local fake APIs, its call row, and the welcome page's /web entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fauxWeb = fileURLToPath(new URL("./fixtures/faux-web-search.mjs", import.meta.url));

async function fakeExa(t) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url, body: JSON.parse(body || "{}") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [
        { url: "https://api-docs.deepseek.com/guides/search", title: "Search & Fetch", highlights: ["raw JSON APIs"], publishedDate: "2026-10-01T00:00:00.000Z" },
        { url: "https://old.example", title: "Old", publishedDate: "2020-01-01T00:00:00.000Z" },
      ] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** The harness, run async so the fake API in this process can answer. */
function runApp(t, { steps, env = {}, setup }) {
  const root = mkdtempSync(join(tmpdir(), "epi-web-tui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [fauxWeb] }));
  setup?.(join(home, ".epi"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harness], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: home, EPI_HOME: join(home, ".epi"), ...env, EPI_TUI_HARNESS: JSON.stringify({ steps, args: ["--no-project", "--model", "epi-faux/websearch"] }) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`harness exit ${code}\n${stderr}\n${stdout.slice(-2000)}`));
      resolve({ ...JSON.parse(stdout), epiHome: join(home, ".epi") });
    });
  });
}

const shown = (screen) => screen.join("\n");

test("no source: the first message asks once; Don't ask again is remembered, and the message still goes", async (t) => {
  // Not offline: offline it doesn't ask (search couldn't run). The faux model is local either way.
  const { screens, epiHome } = await runApp(t, {
    steps: [
      ["waitReady"], ["screen", "welcome"],
      ["type", "hello"], ["key", "enter"], ["waitFor", "Set up web search?", { screen: true }], ["screen", "ask"],
      ["key", "down"], ["key", "down"], ["key", "enter"],
      ["waitFor", { regex: "WEB-DONE|Worked for|web_search" }, { timeoutMs: 20_000 }], ["screen", "after"],
      ["detach"],
    ],
  });
  assert.match(shown(screens.welcome), /\/web web search/, "the welcome page names /web");
  assert.match(shown(screens.ask), /Set it up now[\s\S]*Later[\s\S]*Don't ask again/);
  assert.equal(JSON.parse(readFileSync(join(epiHome, "web.json"), "utf8")).prompt, false);
  assert.match(shown(screens.after), /hello/, "the message was sent");
});

test("a model's search: through the fake Exa, dated, the call row names the range and the count", async (t) => {
  const exa = await fakeExa(t);
  const { screens } = await runApp(t, {
    env: { EPI_TEST_WEB_EXA_URL: exa.url, EPI_WEB_EXA_API_KEY: "test-key" },
    steps: [
      ["waitReady"], ["type", "search it"], ["key", "enter"],
      ["waitFor", { regex: "WEB-DONE[\\s\\S]*Worked for" }, { timeoutMs: 20_000 }], ["wait", 500], ["screen", "done"],
      ["key", "ctrl+o"], ["wait", 300], ["screen", "expanded"],
      ["detach"],
    ],
  });
  assert.equal(exa.requests.length, 1);
  assert.equal(exa.requests[0].path, "/search");
  assert.ok(exa.requests[0].body.startPublishedDate, "the date range reached Exa");
  const done = shown(screens.done);
  // One row in the turn's column; the query gives way to the tail, never the reverse.
  assert.match(done, /├─◆ search "deepseek search.* · after 2026-09-15 · 1 result · 1 out of range +[▏▎▍▌▋▊▉█·]{4}\n/);
  assert.doesNotMatch(done, /Set up web search\?/, "configured: no prompt");
  assert.match(shown(screens.expanded), /2026-10-01 .* Search & Fetch api-docs\.deepseek\.com\/guides\/search \[exa\]/);
});

test("offline, or after Don't ask again, the first message goes without asking", async (t) => {
  const offline = await runApp(t, {
    env: { EPI_OFFLINE: "1" },
    steps: [["waitReady"], ["type", "hello"], ["key", "enter"], ["waitFor", "Worked for", { timeoutMs: 20_000 }], ["screen", "s"], ["detach"]],
  });
  assert.doesNotMatch(offline.output, /Set up web search\?/);
  const declined = await runApp(t, {
    setup: (epiHome) => writeFileSync(join(epiHome, "web.json"), JSON.stringify({ version: 1, prompt: false })),
    steps: [["waitReady"], ["type", "hello"], ["key", "enter"], ["waitFor", "Worked for", { timeoutMs: 20_000 }], ["screen", "s"], ["detach"]],
  });
  assert.doesNotMatch(declined.output, /Set up web search\?/);
});

test("/web: enter a key (masked), its test search runs, and the model can search right away", async (t) => {
  const exa = await fakeExa(t);
  const { screens, epiHome, output } = await runApp(t, {
    env: { EPI_TEST_WEB_EXA_URL: exa.url },
    setup: (epiHome) => writeFileSync(join(epiHome, "web.json"), JSON.stringify({ version: 1, prompt: false })),
    steps: [
      ["waitReady"], ["type", "/web"], ["key", "enter"], ["waitFor", "Web search sources", { screen: true }], ["screen", "panel"],
      // deepseek is first; exa second.
      ["key", "down"], ["key", "enter"], ["waitFor", "Enter API key", { screen: true }],
      ["key", "down"], ["key", "enter"], ["waitFor", "exa API key", { screen: true }],
      ["type", "secret-exa-key-9876"], ["screen", "typing"], ["key", "enter"],
      ["waitFor", "test ok", { timeoutMs: 10_000 }], ["screen", "tested"],
      ["key", "esc"], ["wait", 200], ["key", "esc"], ["wait", 300],
      ["type", "search it"], ["key", "enter"],
      ["waitFor", { regex: "WEB-DONE[\\s\\S]*Worked for" }, { timeoutMs: 20_000 }], ["wait", 300], ["screen", "done"],
      ["detach"],
    ],
  });
  assert.match(shown(screens.panel), /deepseek {2}on · no key/);
  assert.match(shown(screens.panel), /exa {2}on · no key/);
  assert.doesNotMatch(shown(screens.typing), /secret-exa-key/, "the key is drawn masked");
  assert.match(shown(screens.typing), /•{10,}/);
  assert.doesNotMatch(output, /secret-exa-key-9876/, "never written to the terminal at all");
  assert.equal(JSON.parse(readFileSync(join(epiHome, "web-auth.json"), "utf8")).exa.key, "secret-exa-key-9876");
  assert.match(shown(screens.tested), /exa: test ok: 2 results/);
  assert.equal(exa.requests.length, 2, "the test search, then the model's");
  assert.match(shown(screens.done), /├─◆ search "deepseek search/);
});
