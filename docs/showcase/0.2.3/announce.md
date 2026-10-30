# Epi 0.2.3 · launch copy

[← 0.2.3 showcase](README.md)

本版本没有录屏：变化发生在时间里，不在画面上。

---

## Single post

epi 0.2.3: a subagent can no longer hold your session hostage.

• a foreground `task` call gets a 5-minute budget; past it the job moves to the background and keeps running
• the model gets a receipt, not a failure: its answer arrives on its own and starts a turn
• `task_wait` uses the same budget, and a "still running" pull answers with progress instead of a raw snapshot
• `epi -p`, `--mode json` and `rpc` still wait — their process may end first, and a hand-back would lose the work
• wakes now only go to an idle session; before, a notice queued mid-turn could land twice

`epi update`

github.com/RoacherM/epi
