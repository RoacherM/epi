# Epi 0.2.6 · launch copy

[← 0.2.6 showcase](README.md)

---

## Single post

epi 0.2.6: 4-layer `bash` & subagent execution guard (#13), unified `task`/`Monitor` notification ledger, atomic batch `task` rollback, and CLI/Magpie/clipboard hardening.

• 4-layer `bash` guard: `120s` default timeout + `600s` seconds-unit check & `.git/index.lock` timeout hint; 0ms shell preflight against unbounded stream-follow (`tail -f`, `docker logs -f`, allowing `<=60s` probes), interactive TUIs, and detached daemons; `TaskRuntime` subagent `BASH_ENV` PGID ledger + `EPI_WORKER_COOKIE` orphan reaper + non-interactive Git/editor env; immediate `abort()` on quit
• unified `NotificationGate` & `NotificationLedger` across `epi:task` and `epi:monitor` so background alerts survive `/compact`, `Esc`, and `/tree`, plus atomic rollback and `context: "fork"` propagation for batch `task({ tasks })`
• `Monitor` bounds newline-free streams early and guards single-fire WS close; `/tasks` sanitizes control sequences in monitor history
• `epi mcp` rejects unknown subcommands cleanly, `magpie` strips cross-channel stale signatures without leaving empty Gemini turns, and macOS clipboard image paste avoids temp-file races

`epi update`

github.com/RoacherM/epi
