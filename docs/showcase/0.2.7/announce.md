# Epi 0.2.7 · launch copy

[← 0.2.7 showcase](README.md)

---

## Single post

epi 0.2.7: built-in portable `dispatch` engine (DP1) unifying async `bash`, named board peers, timers, non-blocking isolated workspaces, and `/tasks` + `/board` views — usable in Epi and standalone via `pi -e`.

• portable `dispatch` core (`fd 3` JSONL worker channel, zero private Pi internals, `PI_DISPATCH_DEPTH=1` single-layer seal, nested `BASH_ENV` PGID ledger & cookie orphan reaper): detach live foreground `bash` / `task` / `task_wait` anytime with `Alt+B` or `/bg`, schedule `timer` (`follow_up` / `schedule`), and gate task completion with `verifyCommand`
• named peers on a shared session board (`task({ name })` + `board_post` / `board_read` / `board_wait` + `forkFrom`): direct `@name` peer handoffs with parent write-ack consistency, idle-cap pause & `@mention` revival, and deduplicated stall detection — no separate swarm tool surface
• non-blocking async `branch` & CoW `share` workspaces (symlinking `node_modules`, skipping `.dev`, preserving dirty worktrees/clones unless `forceDirty: true`) plus an 88% dual-tab `/tasks` & `/board` live overlay with full OSC 52 / ANSI / bidi sanitization

`epi update`

github.com/RoacherM/epi
