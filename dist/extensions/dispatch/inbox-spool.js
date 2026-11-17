// External event inbox (docs/dispatch-design.md §3.1.2): `<stateDir>/inbox/<target>/{tmp,pending,done}/`.
// Producers (a webhook bridge, a CLI) write `tmp/<uuid>.tmp`, fsync, then hard-link it to
// `pending/<sha256(dedupKey)>.json`: `link()` fails atomically on a duplicate, and a key already in
// `done/` is a replay. One live host owns a target (`owner.lock`); it re-checks ownership before
// every scan and moves an event to `done/` only once the session has persisted its notification.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, writeSync, } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "./reaper.js";
// macOS FSEvents registers a newly created directory asynchronously and may coalesce hard-link
// (`linkSync`) directory updates under heavy load, so an unref'd 1s `readdir` bounds worst-case
// delivery latency (~8µs per tick) when `fs.watch` misses the registration window.
const FALLBACK_SCAN_MS = 1_000;
const DONE_RETENTION_MS = 7 * 24 * 3_600_000;
function targetDir(stateDir, target) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(target))
        throw new Error(`invalid inbox target ${JSON.stringify(target)}`);
    return join(stateDir, "inbox", target);
}
function ensureDirs(dir) {
    for (const sub of ["tmp", "pending", "done"])
        mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
}
export function dedupHash(dedupKey) {
    return createHash("sha256").update(dedupKey).digest("hex");
}
/** Deliver one external event to `target`. Safe from any process, any number of times. */
export function enqueueExternalEvent(stateDir, target, event) {
    const dir = targetDir(stateDir, target);
    ensureDirs(dir);
    const key = dedupHash(event.dedupKey);
    if (existsSync(join(dir, "done", `${key}.json`)))
        return { status: "duplicate", key };
    const tmp = join(dir, "tmp", `${randomUUID()}.tmp`);
    const record = { dedupKey: event.dedupKey, payload: event.payload, receivedAt: Date.now() };
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeSync(fd, `${JSON.stringify(record)}\n`);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        linkSync(tmp, join(dir, "pending", `${key}.json`));
        return { status: "queued", key };
    }
    catch (error) {
        if (error.code === "EEXIST")
            return { status: "duplicate", key };
        throw error;
    }
    finally {
        unlinkSync(tmp);
    }
}
export class InboxSpool {
    options;
    dir;
    lockPath;
    watcher;
    interval;
    delivered = new Set();
    constructor(options) {
        this.options = options;
        this.dir = targetDir(options.stateDir, options.target);
        this.lockPath = join(this.dir, "owner.lock");
    }
    /** Take the target's lock; a live owner is a visible startup error, a dead one is taken over. */
    open() {
        ensureDirs(this.dir);
        const owner = this.readLock();
        if (owner !== undefined && owner.pid !== process.pid && isPidAlive(owner.pid)) {
            throw new Error(`inbox target ${JSON.stringify(this.options.target)} is owned by live pid ${owner.pid} (since ${new Date(owner.startedAt).toISOString()})`);
        }
        const lockTmp = join(this.dir, "tmp", `owner.${process.pid}.${randomUUID()}.tmp`);
        writeFileSync(lockTmp, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, { mode: 0o600 });
        renameSync(lockTmp, this.lockPath);
        this.pruneDone();
        this.scan();
        try {
            this.watcher = watch(join(this.dir, "pending"), () => { try {
                this.scan();
            }
            catch { /* ignore */ } });
            this.watcher.unref();
        }
        catch {
            // fs.watch is only a hint; the interval scan still runs.
        }
        this.interval = setInterval(() => { try {
            this.scan();
        }
        catch { /* ignore */ } }, FALLBACK_SCAN_MS);
        this.interval.unref();
    }
    readLock() {
        try {
            const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
            return typeof lock.pid === "number" ? { pid: lock.pid, startedAt: Number(lock.startedAt) || 0 } : undefined;
        }
        catch {
            return undefined;
        }
    }
    owns() {
        return this.readLock()?.pid === process.pid;
    }
    scan() {
        if (!this.owns()) {
            this.close();
            return;
        }
        let names;
        try {
            names = readdirSync(join(this.dir, "pending")).filter((name) => name.endsWith(".json")).sort();
        }
        catch {
            return;
        }
        for (const name of names)
            this.deliverOne(name.slice(0, -".json".length));
    }
    deliverOne(key) {
        if (this.delivered.has(key))
            return;
        const pending = join(this.dir, "pending", `${key}.json`);
        if (existsSync(join(this.dir, "done", `${key}.json`))) {
            try {
                unlinkSync(pending);
            }
            catch { /* raced */ }
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(pending, "utf8"));
        }
        catch {
            return;
        }
        if (typeof parsed !== "object" || parsed === null || typeof parsed.dedupKey !== "string") {
            try {
                unlinkSync(pending);
            }
            catch { /* raced */ }
            return;
        }
        try {
            if (this.options.deliver(key, parsed))
                this.delivered.add(key);
        }
        catch {
            // Keep the file pending or avoid crashing the host scan loop.
        }
    }
    /** The session persisted the event's notification: move it to `done/`. */
    markDone(key) {
        this.delivered.delete(key);
        try {
            renameSync(join(this.dir, "pending", `${key}.json`), join(this.dir, "done", `${key}.json`));
        }
        catch {
            // Already moved.
        }
    }
    pruneDone() {
        const cutoff = Date.now() - DONE_RETENTION_MS;
        const done = join(this.dir, "done");
        for (const name of readdirSync(done)) {
            try {
                if (statSync(join(done, name)).mtimeMs < cutoff)
                    unlinkSync(join(done, name));
            }
            catch {
                // Raced with another cleanup.
            }
        }
    }
    close() {
        this.watcher?.close();
        this.watcher = undefined;
        clearInterval(this.interval);
        this.interval = undefined;
        if (this.owns()) {
            try {
                unlinkSync(this.lockPath);
            }
            catch { /* gone */ }
        }
    }
}
/** One line for the ledger: the payload as compact JSON (or its text), bounded. */
export function inboxNotice(target, event) {
    const raw = typeof event?.payload === "string" ? event.payload : (JSON.stringify(event?.payload) ?? "");
    return `[inbox ${target}] external event ${event.dedupKey}: ${raw.slice(0, 4_000)}`;
}
//# sourceMappingURL=inbox-spool.js.map