// Registers one value flag and one boolean flag (Pi's `pi.registerFlag`), then records what it
// received on session_start, the same way ambient-probe-extension.mjs records the system prompt --
// used by test/extension-flags.test.mjs to prove MMP forwards extension-registered CLI flags on
// both the TUI/SDK path and the piMain (-p) path.
import { writeFileSync } from "node:fs";

export default function flagExtension(pi) {
  pi.registerFlag("foo", { type: "string", description: "test string flag" });
  pi.registerFlag("flagbool", { type: "boolean", description: "test boolean flag" });
  pi.on("session_start", () => {
    const out = process.env.MMP_FLAG_EXTENSION_OUT;
    if (out) {
      writeFileSync(out, JSON.stringify({ foo: pi.getFlag("foo"), flagbool: pi.getFlag("flagbool") }));
    }
  });
}
