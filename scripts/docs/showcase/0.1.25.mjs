// The 0.1.25 showcase (docs/showcase/0.1.25/): built-in subagents. The parent sends two `reader`
// subagents in one turn, they run at once in their own processes and context windows, and only
// their short answers come back. Recorded by scripts/docs/capture-showcase.mjs.
//
// As an Epi extension (the default export) it registers an offline, scripted model. A subagent
// inherits the Manifest's extensions, so this same file also answers inside each child: the reply
// is chosen by what the request asks, not by order. Tools (`read`, `grep`) really run on the demo
// project, and each subagent is a real Epi worker process.
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "../../../test/fixtures/faux-register.mjs";

export const columns = 120;
export const rows = 34;

const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join("\n");

export const files = {
  "src/auth/session.ts": `${lines(60, (i) => `// session helper ${i}`)}\nexport const SESSION_TTL_SECONDS = 1800;\n`,
  "src/auth/token.ts": `${lines(40, (i) => `// token helper ${i}`)}\nexport function refresh() { return rotate({ graceSeconds: 120 }); }\n`,
  "docs/auth.md": "# Auth\n\nSessions last 30 minutes. Tokens rotate on refresh with a 2-minute grace window.\n",
  // The global agents directory of the demo HOME (cwd is ~/Projects/epi): a project's own
  // .epi/agents only loads in a trusted project, and the demo project is not trusted.
  "../../.epi/agents/reader.md": "---\nname: reader\ndescription: Reads code in its own context and answers with file:line evidence.\ntools: read,grep,find,ls\n---\nAnswer with file:line evidence.\n",
};

const lastUserText = (context) => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  return "";
};
const sawToolResult = (context) => context.messages.some((message) => message.role === "toolResult");
const isChild = (context) => /^Find /.test(lastUserText(context));

function childReply(context) {
  const ask = lastUserText(context);
  const session = ask.includes("session");
  if (!sawToolResult(context)) {
    return fauxAssistantMessage(
      fauxToolCall("grep", { pattern: session ? "SESSION_TTL" : "graceSeconds", path: "src/auth" }),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage(fauxText(session
    ? "Session TTL is 1800 s (30 min): `src/auth/session.ts:61`."
    : "Refresh rotates the token with a 120 s grace window: `src/auth/token.ts:41`."));
}

export default function (pi) {
  let parentStep = 0;
  registerFaux(pi, {
    models: ["offline-demo"],
    reasoning: true,
    tokensPerSecond: 60,
    responses: Array.from({ length: 12 }, () => async (context, options) => {
      await pause(150, options?.signal);
      if (isChild(context)) return childReply(context);
      parentStep += 1;
      if (parentStep === 1) {
        return fauxAssistantMessage([
          fauxThinking("Two independent lookups outside the files I'd edit: send both to readers at once."),
          fauxToolCall("task", { agent: "reader", task: "Find how long a session lasts in src/auth. Answer with file:line." }),
          fauxToolCall("task", { agent: "reader", task: "Find what token refresh does in src/auth. Answer with file:line." }),
        ], { stopReason: "toolUse" });
      }
      // Answer from what really came back, so a failed subagent can never be shown as a success.
      const results = context.messages.filter((message) => message.role === "toolResult");
      const failed = results.filter((message) => message.isError || /unknown task agent|failed/i.test(
        message.content.map((part) => part.text ?? "").join("")));
      if (results.length < 2 || failed.length > 0) {
        return fauxAssistantMessage(fauxText(`The readers did not answer (${failed.length} of ${results.length} failed).`));
      }
      return fauxAssistantMessage(fauxText([
        "Both readers answered, each from its own context window:",
        "",
        "- Sessions last **30 minutes** (`src/auth/session.ts:61`).",
        "- Refresh rotates the token with a **2-minute grace** window (`src/auth/token.ts:41`).",
        "",
        "This conversation only holds their two answers, not the files they read.",
      ].join("\n")));
    }),
  });
}

export async function play(app) {
  app.key("\x1b[200~How long do sessions last, and what does token refresh do? Use readers.\x1b[201~");
  await app.sleep(40);
  app.key("enter");
  await app.waitFor(/^(?![\s\S]*Welcome back)[\s\S]*How long do sessions last/);
  app.record();
  app.mark("start");
  await app.waitFor("Worked for", { timeoutMs: 60000 });
  await app.expect("reader completed");
  await app.sleep(1500);
  await app.still("turn");
  app.mark("end");
  // Ctrl+O: each subagent's answer under its call.
  app.key("\x0f");
  await app.sleep(700);
  await app.still("expanded");
  app.mark("expanded");
}

export const clips = [{ name: "turn", from: "start", to: "end", gif: true }];

export const stills = ["turn", "expanded"];
