// Explicitly declared probe: records what Pi actually loaded at session start.
import { writeFileSync } from "node:fs";

export default function probe(pi) {
  pi.on("session_start", (_event, context) => {
    writeFileSync(
      process.env.MMP_AMBIENT_PROBE_OUT,
      JSON.stringify({
        systemPrompt: context.getSystemPrompt(),
        commands: pi.getCommands().map((command) => command.name),
      }),
    );
  });
}
