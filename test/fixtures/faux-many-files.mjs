// Faux model that writes six files in one assistant message, for /review's cross-file navigation
// and refresh tests: enough files that lazy loading is exercised. Files live under the app's cwd.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const calls = Array.from({ length: 6 }, (_, index) => {
    const name = join(process.cwd(), `file-${index + 1}.ts`);
    writeFileSync(name, `// pre-existing ${index + 1}\n`);
    return fauxToolCall("write", { path: name, content: `// file ${index + 1}\nexport const n${index + 1} = ${index + 1};\n` });
  });
  registerFaux(pi, {
    models: ["many"],
    responses: [
      () => fauxAssistantMessage(calls, { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("MANY-DONE")),
    ],
  });
}
