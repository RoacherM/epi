// Faux model that changes files with the built-in edit and write tools, for /preview's changes
// side: the first prompt edits app.ts (two separate places) and creates notes.md; the second
// edits app.ts again. Files live under the app's cwd.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const app = join(process.cwd(), "app.ts");
  const lines = Array.from({ length: 40 }, (_, index) => `const value${index + 1} = ${index + 1};`);
  lines[4] = "export function getSession() { return readToken(); }";
  writeFileSync(app, `${lines.join("\n")}\n`);
  registerFaux(pi, {
    models: ["editor"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("edit", {
        path: app,
        edits: [
          { oldText: "export function getSession() { return readToken(); }", newText: "export function getSession() { return readTokenSync(); }" },
          { oldText: "const value30 = 30;", newText: "const value30 = 300;\nconst added = true;" },
        ],
      }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("write", { path: join(process.cwd(), "notes.md"), content: "# Notes\n\nwritten by the agent\n" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("EDIT-DONE")),
      () => fauxAssistantMessage(fauxToolCall("edit", {
        path: app,
        edits: [{ oldText: "const value10 = 10;", newText: "const value10 = 10; // second turn" }],
      }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("SECOND-DONE")),
    ],
  });
}
