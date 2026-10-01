// Shared by every place that turns a caught error into a notice: commands.ts,
// session-commands.ts, app.ts, key-handlers.ts, bash-block.ts.
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
