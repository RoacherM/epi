// D86: abort a real in-flight request, without manufacturing its final stopReason.
export default function (pi) {
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") ctx.abort();
  });
}
