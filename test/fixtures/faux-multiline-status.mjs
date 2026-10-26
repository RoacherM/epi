// 测试夹具：命令 /setmultiline 把一个带换行的 status 和一个带换行的 working message 设进去。
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFaux } from "./faux-register.mjs";

export default function (pi) {
  registerFaux(pi, { models: ["nl-model"], responses: [fauxAssistantMessage("NL-OK")] });
  pi.registerCommand("setmultiline", {
    description: "test-only: multi-line status",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("probe", "minilfs s-a92dd73a2f-24\nlocs/0");
    },
  });
  pi.registerCommand("setmultilinestatusline", {
    description: "test-only: multi-line status line (the prompt frame's bottom label)",
    handler: async (_args, ctx) => {
      ctx.ui.setStatusLine(() => "model-x (high) · ↑8.1m ⇣410k\ncache 86%");
    },
  });
  pi.registerCommand("setmultilineworking", {
    description: "test-only: multi-line working message",
    handler: async (_args, ctx) => {
      ctx.ui.setWorking({ message: "Waiting for response\nphantom row" });
    },
  });
  pi.registerCommand("setstatusone", {
    description: "test-only: single-line status",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("probe", "minilfs s-a92dd73a2f-24 · 21 unapplied");
    },
  });
}
