// The trace data model (docs/trace-design.md §5): a projection of the session's branch plus live
// observations into steps a page can list, time and inspect. `duration` and `span` are kept apart
// on purpose: a tool result's `durationMs` is the execute() time, while the observed lifecycle
// span comes from tool_execution_start/end. Neither can stand in for the other.
export {};
//# sourceMappingURL=types.js.map