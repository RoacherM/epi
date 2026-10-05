// Registers /gotoSubdir, which calls ctx.switchSession() on a prebuilt session file whose header
// cwd is EPI_TEST_SWITCH_SESSION_PATH's cwd. This goes straight through the same
// commandContextActions.switchSession that app.ts's bind() wires up, bypassing /resume's own
// selector UI and refusal logic (owned elsewhere) so the test isolates Epi's cwd wiring.
export default function (pi) {
  pi.registerCommand("gotoSubdir", {
    description: "switch to the prebuilt session file at EPI_TEST_SWITCH_SESSION_PATH",
    handler: async (_args, ctx) => {
      const path = process.env.EPI_TEST_SWITCH_SESSION_PATH;
      if (!path) throw new Error("EPI_TEST_SWITCH_SESSION_PATH not set");
      await ctx.switchSession(path);
    },
  });
}
