// Faux model that reads a file under the app's cwd with the built-in read tool, then reports.
// The file lives under process.cwd() (the app's launch directory), not this fixture's own path,
// so its cwd-relative display stays short regardless of how deep the repo checkout is.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const target = join(process.cwd(), "read-me.txt");
  writeFileSync(target, "one\ntwo\nthree\n");
  registerFaux(pi, {
    models: ["reader"],
    responses: [
      () => fauxAssistantMessage(fauxToolCall("read", { path: target }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("READ-DONE")),
    ],
  });
}
