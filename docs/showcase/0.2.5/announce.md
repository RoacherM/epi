# Epi 0.2.5 · launch copy

[← 0.2.5 showcase](README.md)

---

## Single post

epi 0.2.5: async subagents with mid-run pickup & worktree isolation, built-in `Monitor` streaming tool, WeChat image paste fallback, and Antigravity Gemini trajectory normalization.

• `epi:task` picks up background subagent completions and `report_progress` milestones mid-run (`turn_end` / `agent_before_settle`), supports `steer` / `enqueue` / `interrupt` strategies, `isolation: "worktree"`, and parallel batch `tasks` / `task_wait` / `task_cancel`
• new built-in `Monitor`, `monitor_stop`, and `monitor_list` tools stream background command stdout or WebSocket frames with 200ms batching, token-bucket rate limiting, and process-group tree cleanup
• pasting sandbox-protected image paths (e.g. WeChat `EPERM`) automatically falls back to the clipboard image bitmap instead of crashing
• `magpie` provider preserves Antigravity's own Gemini `thoughtSignature`s and normalizes multi-turn Gemini `contents` trajectories

`epi update`

github.com/RoacherM/epi
