// Registers /gotoSubdir, which calls ctx.switchSession() on a prebuilt session file whose header
// cwd is MMP_TEST_SWITCH_SESSION_PATH's cwd. This goes straight through the same
// commandContextActions.switchSession that app.ts's bind() wires up, bypassing /resume's own
// selector UI and refusal logic (owned elsewhere) so the test isolates MMP's cwd wiring.
export default function (pi) {
  pi.registerCommand("gotoSubdir", {
    description: "switch to the prebuilt session file at MMP_TEST_SWITCH_SESSION_PATH",
    handler: async (_args, ctx) => {
      const path = process.env.MMP_TEST_SWITCH_SESSION_PATH;
      if (!path) throw new Error("MMP_TEST_SWITCH_SESSION_PATH not set");
      await ctx.switchSession(path);
    },
  });
}
