// `/ext` sends a user message carrying an image of its own (not a pasted chip) into the running turn.
import { Buffer } from "node:buffer";

const OTHER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgaPj//38Dw38AFPkE/bhh2J8AAAAASUVORK5CYII=",
  "base64",
).toString("base64");

export default function (pi) {
  pi.registerCommand("ext", {
    description: "send a user message with an image",
    handler: async () => {
      pi.sendUserMessage(
        [{ type: "text", text: "EXTMSG" }, { type: "image", data: OTHER_PNG, mimeType: "image/png" }],
        { deliverAs: "steer" },
      );
    },
  });
}
