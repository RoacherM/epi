// Faux model that reads three files with the built-in read tool, one per turn (no text between
// them), then reports -- the real-world shape read-only tool grouping targets (docs/tui-design.md
// 4.2 M4). Files live under process.cwd() (the app's launch directory) for a short cwd-relative
// display, same as faux-read-tool.mjs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const targets = ["one.txt", "two.txt", "three.txt"].map((name) => join(process.cwd(), name));
  targets.forEach((path, index) => writeFileSync(path, `file ${index + 1}\n`));
  registerFaux(pi, {
    models: ["reader"],
    responses: [
      ...targets.map((path) => () => fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" })),
      () => fauxAssistantMessage(fauxText("GROUP-DONE")),
    ],
  });
}
