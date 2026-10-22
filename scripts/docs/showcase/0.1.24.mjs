// The 0.1.24 showcase (docs/showcase/0.1.24/): the rotating x on running calls, settling on their
// glyph with two shakes, and a web_search over DeepSeek and Exa merged and dated.
// Recorded by scripts/docs/capture-showcase.mjs.
//
// As an Epi extension (the default export) it registers an offline, scripted model; tools still run
// for real in the temporary demo project. The two search APIs are local fakes on 127.0.0.1 with
// made-up results (`service`), so nothing reaches the network and no real key is used.
import { createServer } from "node:http";

import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "../../../test/fixtures/faux-register.mjs";

export const columns = 120;
export const rows = 34;

const PORT = 47_311;
const FAKE = `http://127.0.0.1:${PORT}`;

export const env = {
  EPI_OFFLINE: null,
  EPI_TEST_WEB_DEEPSEEK_URL: FAKE,
  EPI_TEST_WEB_EXA_URL: FAKE,
  EPI_WEB_DEEPSEEK_API_KEY: "demo-key",
  EPI_WEB_EXA_API_KEY: "demo-key",
};

const sleepThen = (seconds, lines) => [`await new Promise((resolve) => setTimeout(resolve, ${seconds * 1000}));`, ...lines.map((line) => `console.log(${JSON.stringify(line)});`), ""].join("\n");

export const files = {
  "package.json": `${JSON.stringify({ name: "epi", type: "module", dependencies: { "@earendil-works/pi-coding-agent": "1.1.0" } }, null, 2)}\n`,
  "scripts/test-web.mjs": sleepThen(2.2, ["✓ web search (31 passed)"]),
};

// Made-up results in each API's shape: the same release page from both (merged), one only each finds,
// and an old post that the date range drops.
const DEEPSEEK = { results: [
  { url: "https://github.com/earendil-works/pi/releases/tag/v1.1.0", title: "Release v1.1.0 · earendil-works/pi", summary: "Pi 1.1.0: tool exposure modes, nested tool calls through ctx.executeTool, and faster session replay.", date: "2026-10-14T09:12:00+00:00", authority: 3 },
  { url: "https://pi.dev/docs/changelog", title: "Changelog · Pi", summary: "Every Pi release with its changes, newest first.", date: null, authority: 3 },
  { url: "https://old.example/pi-0-87", title: "Upgrading to Pi 0.87", summary: "Notes from upgrading a harness to Pi 0.87.", date: "2025-09-02T00:00:00+00:00" },
] };
const EXA = { results: [
  { url: "https://www.github.com/earendil-works/pi/releases/tag/v1.1.0/", title: "Pi v1.1.0", highlights: ["tool exposure modes", "ctx.executeTool"], publishedDate: "2026-10-14T00:00:00.000Z" },
  { url: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", title: "@earendil-works/pi-coding-agent", highlights: ["1.1.0 · Published 8 days ago"], publishedDate: "2026-10-14T00:00:00.000Z" },
] };

/** The fake DeepSeek and Exa, while the scenario plays. Returns how to stop them. */
export async function service() {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const body = request.url === "/v1/tools/search" ? DEEPSEEK : request.url === "/search" ? EXA : { error: "no route" };
      // Exa answers a little later, so the call visibly runs.
      setTimeout(() => {
        response.writeHead(body.error ? 404 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      }, request.url === "/search" ? 900 : 500);
    });
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  return () => new Promise((resolve) => server.close(resolve));
}

export default function (pi) {
  const after = (ms, message) => async (_context, options) => {
    await pause(ms, options?.signal);
    return message();
  };
  registerFaux(pi, {
    models: ["offline-demo"],
    reasoning: true,
    tokensPerSecond: 60,
    responses: [
      after(150, () => fauxAssistantMessage([
        fauxThinking("Check what the project pins, then what Pi has released recently."),
        fauxToolCall("read", { path: "package.json" }),
      ], { stopReason: "toolUse" })),
      after(150, () => fauxAssistantMessage(fauxToolCall("web_search", { query: "pi coding agent release", recency: "month", sort: "newest" }), { stopReason: "toolUse" })),
      after(150, () => fauxAssistantMessage(fauxToolCall("bash", { command: "cd ~/Projects/epi && node scripts/test-web.mjs" }), { stopReason: "toolUse" })),
      after(200, () => fauxAssistantMessage(fauxText([
        "You're on the latest: Pi **1.1.0**, released 2026-10-14 (8 days ago). Both DeepSeek and Exa found the release page; the 2025 upgrade notes fell outside the last month and were dropped.",
        "",
        "The web tests pass.",
      ].join("\n")))),
    ],
  });
}

export async function play(app) {
  app.key("\x1b[200~Are we on the latest Pi? Search the web and run the web tests.\x1b[201~");
  await app.sleep(40);
  app.key("enter");
  await app.waitFor(/^(?![\s\S]*Welcome back)[\s\S]*Are we on the latest/);
  app.record();
  app.mark("start");
  await app.waitFor("Worked for", { timeoutMs: 30000 });
  await app.expect("search");
  await app.sleep(1500);
  await app.still("turn");
  app.mark("end");
  // Ctrl+O: every result with its date first.
  app.key("\x0f");
  await app.sleep(700);
  await app.still("expanded");
  app.mark("expanded");
}

export const clips = [{ name: "turn", from: "start", to: "end", gif: true }];

export const stills = ["turn", "expanded"];
