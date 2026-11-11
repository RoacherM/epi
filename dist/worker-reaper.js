import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const REAP_GRACE_MS = 1_500;
const REAP_POLL_MS = 50;
const CONTINUITY_SKEW_MS = 5_000;
const SHARED_DAEMON_NAMES = new Set([
    "tmux", "screen", "mosh-server", "ssh-agent", "gpg-agent", "dbus-daemon", "watchman",
    "fsmonitor--daemon", "fsmonitor--daem", "gradle", "gradledaemon", "bazel", "sccache", "nx", "dockerd",
    "containerd", "hc", "herdr-core", "herdr-app",
]);
const BASH_PGID_HOOK_SCRIPT = [
    'if [ -n "${EPI_PGID_LEDGER:-}" ]; then',
    '  _epi_ledger="$EPI_PGID_LEDGER"; unset EPI_PGID_LEDGER',
    '  _epi_pgid=$(/bin/ps -o pgid= -p "$$" 2>/dev/null || ps -o pgid= -p "$$" 2>/dev/null || printf \'%s\' "$$")',
    '  _epi_pgid="${_epi_pgid//[[:space:]]/}"',
    "  _epi_ts=$(/bin/date +%s 2>/dev/null || date +%s 2>/dev/null || printf '0')",
    '  [ -n "$_epi_pgid" ] && printf \'%s %s\\n\' "$_epi_pgid" "$_epi_ts" >> "$_epi_ledger" 2>/dev/null || true',
    "  unset _epi_ledger _epi_pgid _epi_ts",
    "fi",
    'if [ -n "${EPI_USER_BASH_ENV+x}" ]; then',
    '  BASH_ENV="$EPI_USER_BASH_ENV"; export BASH_ENV',
    '  if [ -n "$EPI_USER_BASH_ENV" ] && [ "$EPI_USER_BASH_ENV" != "${BASH_SOURCE[0]:-}" ] && [ -r "$EPI_USER_BASH_ENV" ]; then',
    '    . "$EPI_USER_BASH_ENV"',
    "  fi",
    "else unset BASH_ENV; fi",
    "",
].join("\n");
const ABORT_EDITOR_SCRIPT = "#!/bin/sh\necho \"epi: interactive git editor blocked in headless subagent; pass -m or --no-edit instead.\" >&2\nexit 1\n";
export function prepareWorkerExecutionGuard(guardDir, jobId, baseEnv) {
    const cookie = `wk_${jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}_${randomBytes(6).toString("hex")}`;
    const ledgerPath = join(guardDir, "pgids.log");
    const hookPath = join(guardDir, "epi-pgid.sh");
    const editorPath = join(guardDir, "epi-abort-editor.sh");
    writeFileSync(ledgerPath, "", { mode: 0o600 });
    writeFileSync(hookPath, BASH_PGID_HOOK_SCRIPT, { mode: 0o600 });
    writeFileSync(editorPath, ABORT_EDITOR_SCRIPT, { mode: 0o700 });
    chmodSync(editorPath, 0o700);
    const env = {
        ...baseEnv,
        EPI_WORKER_COOKIE: cookie,
        GIT_TERMINAL_PROMPT: baseEnv.GIT_TERMINAL_PROMPT ?? "0",
        GCM_INTERACTIVE: baseEnv.GCM_INTERACTIVE ?? "never",
        GIT_PAGER: baseEnv.GIT_PAGER ?? "cat",
    };
    if (process.platform !== "win32") {
        env.EPI_PGID_LEDGER = ledgerPath;
        if (baseEnv.BASH_ENV !== undefined)
            env.EPI_USER_BASH_ENV = baseEnv.BASH_ENV;
        else
            delete env.EPI_USER_BASH_ENV;
        env.BASH_ENV = hookPath;
        env.GIT_EDITOR = baseEnv.GIT_EDITOR ?? editorPath;
        env.GIT_SEQUENCE_EDITOR = baseEnv.GIT_SEQUENCE_EDITOR ?? editorPath;
    }
    return { cookie, ledgerPath, env, createdAtMs: Date.now(), descendantPgids: new Map() };
}
function isPgidAlive(pgid) {
    if (process.platform === "win32" || pgid <= 1)
        return false;
    try {
        process.kill(-pgid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function parseLedgerEntries(content, fallbackMs) {
    const out = [];
    for (const raw of content.split("\n")) {
        const [pgidStr, secStr] = raw.trim().split(/\s+/);
        const pgid = Number(pgidStr);
        if (!Number.isInteger(pgid) || pgid <= 1)
            continue;
        const sec = Number(secStr);
        out.push({ pgid, seenAtMs: Number.isFinite(sec) && sec > 0 ? sec * 1_000 : fallbackMs });
    }
    return out;
}
export function initialLedgerOffset(ledgerPath) {
    if (!ledgerPath || !existsSync(ledgerPath))
        return 0;
    try {
        return statSync(ledgerPath).size;
    }
    catch {
        return 0;
    }
}
export function inspectNewWorkerBackgroundPgids(ledgerPath, byteOffset, warnedPgids) {
    if (process.platform === "win32" || !existsSync(ledgerPath))
        return { nextOffset: byteOffset };
    let buf;
    try {
        buf = readFileSync(ledgerPath);
    }
    catch {
        return { nextOffset: byteOffset };
    }
    const safeOffset = Math.min(byteOffset, buf.length);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < safeOffset)
        return { nextOffset: safeOffset };
    const nextOffset = lastNewline + 1;
    const alivePgids = [];
    for (const { pgid } of parseLedgerEntries(buf.subarray(safeOffset, nextOffset).toString("utf8"), Date.now())) {
        if (pgid === process.pid || pgid === process.ppid || warnedPgids.has(pgid))
            continue;
        if (isPgidAlive(pgid)) {
            warnedPgids.add(pgid);
            alivePgids.push(pgid);
        }
    }
    return alivePgids.length === 0
        ? { nextOffset }
        : { nextOffset, warning: `[epi: background process group PGID ${alivePgids.join(", ")} survived after bash exited and will be automatically terminated when this subagent task finishes.]` };
}
const DARWIN_PROCARGS_PERL = [
    "my $needle = <STDIN>; defined $needle or exit 0; chomp $needle;",
    "while (my $line = <STDIN>) {",
    "  chomp $line; my $pid = int($line); next if $pid <= 1;",
    '  my $mib = pack("i3", 1, 49, $pid); my $len = pack("Q", 0);',
    "  next if syscall(202, $mib, 3, 0, $len, 0, 0) != 0;",
    '  my $sz = unpack("Q", $len); next if $sz <= 4 || $sz > 1048576;',
    '  my $buf = "\\0" x $sz;',
    "  next if syscall(202, $mib, 3, $buf, $len, 0, 0) != 0;",
    '  my $actual = unpack("Q", $len); next if $actual <= 4;',
    "  my $raw = substr($buf, 4, $actual - 4); next if length($needle) > 0 && index($raw, $needle) < 0;",
    "  $raw =~ tr/\\0\\r\\n\\t/    /;",
    '  print "$pid\\t$raw\\n";',
    "}",
].join("\n");
function parsePsLine(line) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*(.*)$/.exec(line);
    if (!match)
        return undefined;
    const parsedStart = Date.parse(match[5]);
    return {
        pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]),
        startMs: Number.isFinite(parsedStart) ? parsedStart : undefined, comm: match[6], command: match[7] ?? "",
    };
}
function parseLsofField(cur, tag, val) {
    if (tag === "R")
        cur.ppid = Number(val);
    else if (tag === "g")
        cur.pgid = Number(val);
    else if (tag === "u")
        cur.uid = Number(val);
    else if (tag === "c") {
        cur.comm = val;
        cur.command = val;
    }
}
function parseLsofRows(output, fallbackUid) {
    const rows = [];
    let cur;
    for (const line of output.split("\n")) {
        if (line.length < 2)
            continue;
        const tag = line[0];
        const val = line.slice(1);
        if (tag === "p") {
            if (cur && cur.pid > 0 && cur.pgid > 0)
                rows.push(cur);
            cur = { pid: Number(val), ppid: 0, pgid: 0, uid: fallbackUid, startMs: undefined, comm: "", command: "" };
        }
        else if (cur) {
            parseLsofField(cur, tag, val);
        }
    }
    if (cur && cur.pid > 0 && cur.pgid > 0)
        rows.push(cur);
    return rows;
}
function runCommandAsync(bin, args, input) {
    return new Promise((resolve) => {
        try {
            const child = input === undefined
                ? execFile(bin, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024, timeout: 2_500 }, (err, stdout) => {
                    resolve({ ok: !err, stdout: typeof stdout === "string" ? stdout : "" });
                })
                : spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
            if (input === undefined || !("stdin" in child) || !child.stdin || !child.stdout)
                return;
            let out = "";
            const timer = setTimeout(() => { try {
                child.kill("SIGKILL");
            }
            catch { /* ignore */ } }, 2_500);
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => { if (out.length < 64 * 1024 * 1024)
                out += chunk; });
            child.on("error", () => { clearTimeout(timer); resolve({ ok: false, stdout: out }); });
            child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout: out }); });
            child.stdin.on("error", () => { });
            child.stdin.end(input);
        }
        catch {
            resolve({ ok: false, stdout: "" });
        }
    });
}
async function queryDarwinProcArgs(pids, needle) {
    const out = new Map();
    if (pids.length === 0 || !existsSync("/usr/bin/perl"))
        return out;
    const { stdout } = await runCommandAsync("/usr/bin/perl", ["-e", DARWIN_PROCARGS_PERL], `${needle}\n${pids.join("\n")}\n`);
    for (const line of stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0)
            out.set(Number(line.slice(0, tab)), line.slice(tab + 1));
    }
    return out;
}
async function listDarwinSandboxProcessesAsync(cookieToken, hasLiveKnownPgids) {
    const uid = process.getuid?.();
    if (uid === undefined || !existsSync("/usr/sbin/lsof"))
        return [];
    let cookieArgs = new Map();
    if (existsSync("/usr/bin/pgrep")) {
        const { stdout: pidList } = await runCommandAsync("/usr/bin/pgrep", ["-u", String(uid)]);
        const pids = pidList.split("\n").map((s) => Number(s.trim())).filter((n) => n > 1);
        cookieArgs = await queryDarwinProcArgs(pids, cookieToken);
        if (!hasLiveKnownPgids && cookieArgs.size === 0)
            return [];
    }
    const { stdout } = await runCommandAsync("/usr/sbin/lsof", ["-n", "-P", "-u", String(uid), "-a", "-d", "cwd", "-F", "pRgnuc"]);
    if (stdout.length === 0)
        return [];
    const rows = parseLsofRows(stdout, uid);
    const fullArgs = await queryDarwinProcArgs(rows.map((r) => r.pid), "");
    for (const row of rows)
        row.command = fullArgs.get(row.pid) ?? cookieArgs.get(row.pid) ?? row.command;
    return rows;
}
async function listUnixProcessesAsync(cookieToken, hasLiveKnownPgids) {
    if (process.platform === "win32")
        return [];
    const psBin = existsSync("/bin/ps") ? "/bin/ps" : "ps";
    const args = process.platform === "darwin"
        ? ["-axwwE", "-o", "pid=,ppid=,pgid=,uid=,lstart=,comm=,command="]
        : ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,comm=,args="];
    const { ok, stdout } = await runCommandAsync(psBin, args);
    if (ok)
        return stdout.split("\n").map(parsePsLine).filter((row) => row !== undefined);
    return process.platform === "darwin" ? listDarwinSandboxProcessesAsync(cookieToken, hasLiveKnownPgids) : [];
}
function listUnixProcessesSync() {
    if (process.platform === "win32")
        return [];
    const psBin = existsSync("/bin/ps") ? "/bin/ps" : "ps";
    try {
        const out = execFileSync(psBin, ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,comm=,args="], {
            encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024, timeout: 2_500,
        });
        return out.split("\n").map(parsePsLine).filter((row) => row !== undefined);
    }
    catch {
        const uid = process.getuid?.();
        if (process.platform !== "darwin" || uid === undefined || !existsSync("/usr/sbin/lsof"))
            return [];
        try {
            const out = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-u", String(uid), "-a", "-d", "cwd", "-F", "pRgnuc"], {
                encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 2_500,
            });
            return parseLsofRows(out, uid);
        }
        catch (err) {
            const stdout = err?.stdout;
            return typeof stdout === "string" && stdout.length > 0 ? parseLsofRows(stdout, uid) : [];
        }
    }
}
function hasDirectChildren(rootPid) {
    if (!existsSync("/usr/bin/pgrep"))
        return true;
    try {
        return execFileSync("/usr/bin/pgrep", ["-P", String(rootPid)], { encoding: "utf8", timeout: 1_000 }).trim().length > 0;
    }
    catch {
        return false;
    }
}
export function snapshotDescendantPgids(rootPid, guard) {
    if (process.platform === "win32" || rootPid === undefined || rootPid <= 1 || !hasDirectChildren(rootPid))
        return;
    const childrenByPpid = new Map();
    for (const row of listUnixProcessesSync()) {
        const list = childrenByPpid.get(row.ppid) ?? [];
        list.push(row);
        childrenByPpid.set(row.ppid, list);
    }
    const now = Date.now();
    const queue = [rootPid];
    const visited = new Set([rootPid]);
    while (queue.length > 0) {
        for (const child of childrenByPpid.get(queue.shift()) ?? []) {
            if (visited.has(child.pid))
                continue;
            visited.add(child.pid);
            queue.push(child.pid);
            if (child.pgid > 1)
                guard.descendantPgids.set(child.pgid, now);
        }
    }
}
function scanLinuxProcCookiePids(cookieToken, currentUid, rowsByPid) {
    if (process.platform !== "linux" || !existsSync("/proc"))
        return [];
    let entries;
    try {
        entries = readdirSync("/proc");
    }
    catch {
        return [];
    }
    const matched = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry))
            continue;
        const row = rowsByPid.get(Number(entry));
        if (!row || row.uid !== currentUid || row.pgid <= 1)
            continue;
        try {
            if (readFileSync(`/proc/${row.pid}/environ`, "utf8").split("\0").includes(cookieToken))
                matched.push(row.pgid);
        }
        catch { /* exited */ }
    }
    return matched;
}
function isSharedDaemonRow(row) {
    const commBase = basename(row.comm).toLowerCase();
    const firstArg = basename(row.command.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (SHARED_DAEMON_NAMES.has(commBase) || SHARED_DAEMON_NAMES.has(firstArg))
        return true;
    if ((commBase === "ssh" || firstArg === "ssh") && /(?:\s-M\b|\[mux\]|ControlMaster)/i.test(row.command))
        return true;
    return /git\s+fsmonitor--daemon|GradleDaemon/i.test(row.command);
}
function readKnownPgids(guard, reapAtMs) {
    const candidates = new Map(guard.descendantPgids);
    if (existsSync(guard.ledgerPath)) {
        try {
            for (const item of parseLedgerEntries(readFileSync(guard.ledgerPath, "utf8"), reapAtMs)) {
                candidates.set(item.pgid, Math.max(candidates.get(item.pgid) ?? 0, item.seenAtMs));
            }
        }
        catch { /* ignore */ }
    }
    return candidates;
}
function collectCandidatePgids(knownPgids, cookieToken, rows, currentUid, reapAtMs) {
    const candidates = new Map(knownPgids);
    if (process.platform === "darwin") {
        for (const row of rows) {
            if (row.uid === currentUid && row.pgid > 1 && row.command.includes(cookieToken))
                candidates.set(row.pgid, reapAtMs);
        }
    }
    else if (process.platform === "linux") {
        for (const pgid of scanLinuxProcCookiePids(cookieToken, currentUid, new Map(rows.map((r) => [r.pid, r])))) {
            candidates.set(pgid, reapAtMs);
        }
    }
    return candidates;
}
function isUnsafeMember(m, currentUid, selfPgid, minStartMs, maxStartMs) {
    if (m.uid !== currentUid || m.pid === process.pid || m.pid === process.ppid)
        return true;
    if (selfPgid !== undefined && m.pgid === selfPgid)
        return true;
    if (isSharedDaemonRow(m))
        return true;
    return m.startMs !== undefined && (m.startMs < minStartMs || m.startMs > maxStartMs);
}
function selectSafeTargetPgids(candidates, rows, currentUid, createdAtMs, reapAtMs) {
    const selfPgid = rows.find((r) => r.pid === process.pid)?.pgid;
    const membersByPgid = new Map();
    for (const row of rows) {
        const list = membersByPgid.get(row.pgid) ?? [];
        list.push(row);
        membersByPgid.set(row.pgid, list);
    }
    const minStartMs = createdAtMs - CONTINUITY_SKEW_MS;
    const targets = [];
    for (const [pgid, seenAtMs] of candidates) {
        if (pgid <= 1 || pgid === process.pid || pgid === process.ppid || pgid === selfPgid)
            continue;
        const members = membersByPgid.get(pgid);
        if (!members || members.length === 0)
            continue;
        const maxStartMs = Math.max(seenAtMs, reapAtMs) + CONTINUITY_SKEW_MS;
        if (!members.some((m) => isUnsafeMember(m, currentUid, selfPgid, minStartMs, maxStartMs)))
            targets.push(pgid);
    }
    return targets;
}
function signalPgids(pgids, signal) {
    for (const pgid of pgids) {
        try {
            process.kill(-pgid, signal);
        }
        catch { /* gone */ }
    }
}
export async function reapWorkerOrphans(guard) {
    if (guard === undefined || process.platform === "win32")
        return [];
    if (guard.descendantPgids.size === 0 && initialLedgerOffset(guard.ledgerPath) === 0)
        return [];
    const currentUid = process.getuid?.();
    if (currentUid === undefined)
        return [];
    const reapAtMs = Date.now();
    const knownPgids = readKnownPgids(guard, reapAtMs);
    const hasLiveKnown = [...knownPgids.keys()].some((pgid) => pgid !== process.pid && pgid !== process.ppid && isPgidAlive(pgid));
    const cookieToken = `EPI_WORKER_COOKIE=${guard.cookie}`;
    const rows = await listUnixProcessesAsync(cookieToken, hasLiveKnown);
    const targets = rows.length === 0
        ? []
        : selectSafeTargetPgids(collectCandidatePgids(knownPgids, cookieToken, rows, currentUid, reapAtMs), rows, currentUid, guard.createdAtMs, reapAtMs);
    if (targets.length === 0)
        return [];
    signalPgids(targets, "SIGTERM");
    const deadline = Date.now() + REAP_GRACE_MS;
    let remaining = targets.filter((pgid) => isPgidAlive(pgid));
    while (remaining.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, REAP_POLL_MS));
        remaining = remaining.filter((pgid) => isPgidAlive(pgid));
    }
    if (remaining.length > 0)
        signalPgids(remaining, "SIGKILL");
    return targets;
}
//# sourceMappingURL=worker-reaper.js.map