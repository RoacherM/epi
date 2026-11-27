# Epi 0.2.10 · launch copy

[← 0.2.10 showcase](README.md)

---

## Single post

epi 0.2.10: trace-driven runtime tightening (DP2) for KV-cache prefix stability, repeat-loop protection, unified headless drain, and Magpie session affinity.

• stable tool schema prefix: dropped runtime `setActiveTools` churn and `board_wait`, keeping `board_post` / `board_read` statically fixed from turn 0 while splitting `task` `role: "worker" | "peer"` and defaulting subagent `epi:web` off (preset `web: true` when needed)
• simpler `bash` routing & bounded waits: `bash` now takes `mode?: "auto" | "background" | "daemon"`, `FixedPointGuard` flags byte-identical back-to-back tool loops, TUI `task_wait` respects `foregroundBudgetSeconds` (300s default), and `DrainBarrier` unifies `monitor` settle draining without duplicate wakes
• Magpie affinity & forward compat: OpenAI/Anthropic Magpie models enable `sendSessionAffinityHeaders: true` by default and accept all 11 `pi-ai` `thinking_format` values

`epi update`

github.com/RoacherM/epi
