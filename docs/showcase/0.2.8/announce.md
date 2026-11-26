# Epi 0.2.8 · launch copy

[← 0.2.8 showcase](README.md)

---

## Single post

epi 0.2.8: `bash({ isDaemon: true })` background servers started in headless `epi -p` / `--mode json` (and `pi -p -e`) now survive clean CLI exit without `SIGPIPE` or false orphan reaping (#16).

• file-backed daemon `stdout`/`stderr` (`O_APPEND` onto `<stateDir>/bg/<id>.log` with bounded 64 KiB tail reads): HTTP, Flask, PyPI, and gRPC servers keep writing access logs after `epi -p` exits without hitting `SIGPIPE` / `EPIPE`
• clean headless root detach (`detachDaemons()` on `print`/`json` quit): closes parent `stdin`, unrefs child handles so `epi -p` and standalone `pi -p` exit promptly, and marks `detached: true` so subsequent startups in the same `EPI_HOME` do not reap live daemons as crashed orphans
• scoped lifecycle & `--continue` control: resumed sessions still inspect post-exit logs via `task_status` and stop detached daemons cleanly via `task_cancel`, while interactive TUI quit, subagent workers, fatal signals, and unclean host crashes continue to reap process groups

`epi update`

github.com/RoacherM/epi
