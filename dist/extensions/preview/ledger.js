// The change ledger (docs/preview-design.md §2): what each file was before the agent changed it.
// Fed by the extension's tool_call and agent_start/agent_end handlers; read by the changes view.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_TEXT_BYTES } from "./files.js";
/** Tools that write files, and where their path argument is (Pi's built-in edit and write). */
const WRITING_TOOLS = new Set(["edit", "write"]);
function snapshot(path) {
    try {
        const size = statSync(path).size;
        if (size > MAX_TEXT_BYTES)
            return { kind: "not-kept", reason: "larger than 4 MB" };
        return { kind: "text", text: readFileSync(path, "utf8") };
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return { kind: "absent" };
        return { kind: "not-kept", reason: "could not be read before the change" };
    }
}
export class ChangeLedger {
    turn = 0;
    entries = new Map();
    listeners = new Set();
    /** The agent is running a turn. */
    running = false;
    /** A tool is about to run: keep what a file it writes looks like now. */
    onToolCall(toolName, input, cwd) {
        if (!WRITING_TOOLS.has(toolName))
            return;
        const path = input?.path;
        if (typeof path !== "string" || path === "")
            return;
        const absolute = resolve(cwd, path);
        const entry = this.entries.get(absolute);
        if (entry === undefined) {
            const before = snapshot(absolute);
            this.entries.set(absolute, { sessionBefore: before, turn: this.turn, turnBefore: before });
        }
        else if (entry.turn !== this.turn) {
            entry.turn = this.turn;
            entry.turnBefore = snapshot(absolute);
        }
        this.notify();
    }
    onAgentStart() {
        this.turn += 1;
        this.running = true;
        this.notify();
    }
    onAgentEnd() {
        this.running = false;
        this.notify();
    }
    /** Changed files in the scope, sorted by path. */
    changes(scope) {
        const changes = [];
        for (const [path, entry] of this.entries) {
            if (scope === "session")
                changes.push({ path, before: entry.sessionBefore });
            else if (entry.turn === this.turn)
                changes.push({ path, before: entry.turnBefore });
        }
        return changes.sort((a, b) => a.path.localeCompare(b.path));
    }
    /** Called on every change; returns the unsubscribe function. */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    notify() {
        for (const listener of this.listeners)
            listener();
    }
}
//# sourceMappingURL=ledger.js.map