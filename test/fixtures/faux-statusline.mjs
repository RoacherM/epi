// A faux model plus two test-only commands: /setstatusline installs a custom status line
// formatter, /resetstatusline restores the built-in. Installed through commands on purpose --
// /new re-invokes the extension factory, so a formatter installed on session_start would be
// silently reinstalled after a session switch, and tests could never catch the app wrongly
// clearing the slot.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, {
    models: ["model-a"],
    responses: [fauxAssistantMessage("STATUSLINE-OK"), fauxAssistantMessage("STATUSLINE-AGAIN")],
  });
  pi.registerCommand("setstatusline", {
    description: "test-only: install a custom status line",
    handler: async (_args, ctx) => {
      ctx.ui.setStatusLine((stats) => `CUSTOM in=${stats.input} out=${stats.output}`);
    },
  });
  pi.registerCommand("resetstatusline", {
    description: "test-only: restore the default status line",
    handler: async (_args, ctx) => {
      ctx.ui.setStatusLine(undefined);
    },
  });
}
