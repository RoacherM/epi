// The 0.2.2 showcase (docs/showcase/0.2.2/): long pastes fold and open in full, and a subagent's
// progress opens from the footer and from its call row. Recorded by scripts/docs/capture-showcase.mjs.
//
// As an Epi extension (the default export) it registers an offline, scripted model. A subagent
// inherits the Manifest's extensions, so this file also answers inside the child: the reply is
// chosen by what the request asks, not by order. Tools really run on the demo project, and the
// subagent is a real Epi worker process with its own session file.
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "../../../test/fixtures/faux-register.mjs";

export const columns = 120;
export const rows = 34;

const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join("\n");

export const files = {
  "src/gitpaths.ts": `${lines(40, (i) => `// ref helper ${i}`)}\nexport function readRefGraph(root) { return resolveAll(root, readHead(root)); }\n`,
  "src/bindings.ts": `${lines(30, (i) => `// binding helper ${i}`)}\nexport const RECOVERY_MARKER = ".epi-recovery";\n`,
  "src/recovery.ts": `${lines(20, (i) => `// recovery helper ${i}`)}\nexport function writeRecovery(path, data) { writeFileSync(path, data); }\n`,
  // The global agents directory of the demo HOME (cwd is ~/Projects/epi), as in 0.1.25.
  "../../.epi/agents/reader.md": "---\nname: reader\ndescription: Reads code in its own context and answers with file:line evidence.\ntools: read,grep,find,ls\n---\nAnswer with file:line evidence.\n",
};

// Three long paragraphs, under 4 lines and under 10 KB: before 0.2.2 these went into the prompt raw.
const FINDING = "复审又找到 3 个 Major：ref 图在加锁前检查；保护标记只记在项目绑定里，文件夹一移动就失效；恢复文件和绑定文件写入时没有 fsync。";
export const NOTES = [
  `第四轮修复已完成，但还不能推送。${FINDING}每个新测试在修复前失败、修复后通过，完整测试套件全过。`.repeat(6),
  "另外还有 6 个 Minor（P4–P9），例如大小写不敏感的卷上 Main 和 main 被当成两个 ref，linked worktree 自己的 ref 去主仓库目录里找。".repeat(4),
  "备注：每轮的 Major 数是 13 → 7 → 2 → 3，数量没再下降，但问题越来越边缘。",
].join("\n");

const textOf = (message) => (typeof message.content === "string"
  ? message.content
  : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
const firstUser = (context) => textOf(context.messages.find((message) => message.role === "user") ?? { content: "" });
const results = (context) => context.messages.filter((message) => message.role === "toolResult").length;
const isChild = (context) => firstUser(context).startsWith("Check the three Majors");

async function childReply(context, signal) {
  const step = results(context);
  if (step === 0) {
    await pause(600, signal);
    return fauxAssistantMessage([
      fauxThinking("Start where the ref graph is read, then the marker and the writes."),
      fauxToolCall("grep", { pattern: "readRefGraph|RECOVERY_MARKER|writeFileSync", path: "src" }),
    ], { stopReason: "toolUse" });
  }
  if (step === 1) {
    await pause(1400, signal);
    return fauxAssistantMessage([
      fauxText("The ref graph is read with no lock held. Next, the marker and the recovery write."),
      fauxToolCall("read", { path: "src/bindings.ts" }),
    ], { stopReason: "toolUse" });
  }
  if (step === 2) {
    await pause(1400, signal);
    return fauxAssistantMessage(fauxToolCall("read", { path: "src/recovery.ts" }), { stopReason: "toolUse" });
  }
  await pause(2200, signal);
  return fauxAssistantMessage(fauxText([
    "All three hold:",
    "- P1 `src/gitpaths.ts:41` reads the ref graph before any lock.",
    "- P2 `src/bindings.ts:31` keeps the marker in the project binding only.",
    "- P3 `src/recovery.ts:21` writes without fsync.",
  ].join("\n")));
}

export default function (pi) {
  let parentStep = 0;
  registerFaux(pi, {
    models: ["offline-demo"],
    reasoning: true,
    tokensPerSecond: 80,
    responses: Array.from({ length: 16 }, () => async (context, options) => {
      if (isChild(context)) return childReply(context, options?.signal);
      await pause(150, options?.signal);
      parentStep += 1;
      if (parentStep === 1) {
        return fauxAssistantMessage([
          fauxThinking("A wide check outside the files I would edit: hand it to a reader in the background."),
          fauxToolCall("task", {
            agent: "reader",
            task: "Check the three Majors in the round-4 notes against src/: answer with file:line for each.",
            background: true,
          }),
        ], { stopReason: "toolUse" });
      }
      if (parentStep === 2) return fauxAssistantMessage(fauxText("A reader is checking the three Majors in the background; I'll report when it answers."));
      return fauxAssistantMessage(fauxText("The reader confirmed all three Majors (P1–P3), each with its file and line."));
    }),
  });
}

export async function play(app) {
  // 1. Three long paragraphs fold into one chip; its popup opens the full text.
  app.record();
  app.mark("paste");
  app.key(`\x1b[200~${NOTES}\x1b[201~`);
  await app.waitFor(/Pasted: [\d.]+ KB/);
  await app.sleep(1200);
  await app.still("chip");
  await app.clickText("click to view");
  await app.waitFor("e edit");
  await app.sleep(1500);
  for (const key of ["j", "j", "j", "j", "j", "j"]) { app.key(key); await app.sleep(120); }
  await app.sleep(600);
  await app.still("viewer");
  app.key("q");
  await app.sleep(400);
  app.mark("pasted");

  // 2. Send it; the model starts a background reader. The footer count opens the jobs list, and
  //    the job's page updates while the reader works.
  app.key("enter");
  await app.waitFor("◐ 1 task", { timeoutMs: 30000 });
  await app.sleep(900);
  app.mark("tasks");
  await app.clickText("1 task");
  await app.waitFor("tasks (1 job)");
  await app.sleep(1200);
  await app.still("list");
  app.key("\r");
  await app.waitFor("(running)");
  await app.sleep(800);
  await app.still("running");
  await app.waitFor("All three hold", { timeoutMs: 30000 });
  await app.sleep(1500);
  await app.still("job");
  app.key("\x1b");
  await app.sleep(300);
  app.key("\x1b");
  await app.waitFor("Worked for", { timeoutMs: 30000 });
  await app.sleep(1200);

  // 3. The task's own call row opens the same page.
  await app.clickText("task reader", { offset: 2 });
  await app.waitFor("(completed)");
  await app.sleep(1500);
  app.key("\x1b");
  await app.sleep(600);
  await app.still("turn");
  app.mark("end");
}

export const clips = [
  { name: "paste", from: "paste", to: "pasted", gif: true },
  { name: "tasks", from: "tasks", to: "end", gif: true },
];

export const stills = ["chip", "viewer", "list", "running", "job", "turn"];
