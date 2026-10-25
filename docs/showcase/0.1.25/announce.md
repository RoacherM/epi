# Epi 0.1.25 · launch copy

[← 0.1.25 showcase](README.md)

Attach `turn.mp4`. Model replies are scripted (`offline-demo`); each subagent is a real Epi worker process and `grep` really ran.

---

## Single post

epi 0.1.25: built-in subagents that keep your main context clean.

• `task` runs a subagent in its own process and context window; only its answer comes back. Several `task` calls in one turn run at once
• watch and steer: `task_status` shows what a running subagent is doing; `task({ jobId, task })` steers it, or resumes it after it finished
• a subagent compacts its own context, and if that cannot save it, stops cleanly with the work so far
• presets in `~/.epi/agents/*.md` (model, tools, skills, MCP…), e.g. a cheap reader on a fast model
• Magpie models now carry real prices and a cache lifetime, so prompt-cache warming works

`epi update`

github.com/RoacherM/epi
