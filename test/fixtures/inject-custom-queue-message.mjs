// Test-only `/schedule-inject [followUp]` command: schedules a pi.sendMessage call a moment later,
// so it can land *while a turn is streaming* without going through the TUI's own Enter-key command
// dispatch (which would just queue the literal command text as an ordinary follow-up while
// streaming, never actually invoking the command). AgentSession.sendCustomMessage
// (agent-session.js ~1496) delivers a streaming custom message straight into the Agent's own queue
// (agent.steer by default, or agent.followUp with deliverAs:"followUp") with no corresponding entry
// in AgentSession's plain-text _steeringMessages/_followUpMessages arrays. Used to prove app.ts's
// clearAllQueues pairs a peeked queued message back to its text entry by content, not position
// (item 3, pre-merge review): this injected message must not be mistaken for -- or have its
// (non-existent) images attached to -- a real queued follow-up queued around the same time. With no
// argument it uses the *default* deliverAs (steer, agent-session.js's own default), which pre-merge
// review found a second bug in: gating the steering-queue peek/clear on
// session.getSteeringMessages() being non-empty (it's empty here, since this bypasses that array
// entirely) skipped clearing steering, so the one peekQueuedMessages() call left returned the
// injected *steering* content instead of the real follow-up, losing its image the same way.
export default function (pi) {
  // sendMessage lives on the extension runtime (`pi`, ExtensionActions) passed to this factory, not
  // on a command handler's ctx (ExtensionCommandContext) -- captured in closure here instead.
  pi.registerCommand("schedule-inject", {
    description: "test-only: queues a custom message directly into the agent's own queue, shortly",
    handler: async (args, ctx) => {
      const deliverAs = args.trim() === "followUp" ? "followUp" : undefined;
      setTimeout(() => {
        pi.sendMessage(
          { customType: "probe", content: [{ type: "text", text: "injected-custom-message" }], display: false },
          deliverAs === undefined ? undefined : { deliverAs },
        );
        ctx.ui.notify("injected-custom-message sent", "info");
      }, 800);
    },
  });
}
