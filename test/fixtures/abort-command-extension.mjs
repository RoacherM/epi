// Test-only `/doabort` command: calls ctx.abort(), the same ExtensionContextActions.abort()
// app.ts's bindExtensions wires an abortHandler for. Lets tests exercise that handler (bug 3)
// without depending on a real terminal key press.
export default function (pi) {
  pi.registerCommand("doabort", {
    description: "test-only: calls ctx.abort()",
    handler: async (_args, ctx) => {
      ctx.abort();
    },
  });
}
