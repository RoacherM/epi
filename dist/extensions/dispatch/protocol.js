import { StringDecoder } from "node:string_decoder";
export const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
export const CAPSULE_VERSION = 1;
/** Newline-delimited JSON over a duplex stream; a malformed or oversized line is reported once. */
export class JsonlChannel {
    stream;
    onMessage;
    buffer = "";
    decoder = new StringDecoder("utf8");
    protocolError;
    constructor(stream, onMessage, onClose) {
        this.stream = stream;
        this.onMessage = onMessage;
        stream.on("data", (chunk) => this.receive(typeof chunk === "string" ? chunk : this.decoder.write(chunk)));
        stream.on("end", onClose);
        stream.on("error", onClose);
        stream.on("close", onClose);
    }
    receive(text) {
        if (this.protocolError !== undefined)
            return;
        this.buffer += text;
        if (Buffer.byteLength(this.buffer) > MAX_PROTOCOL_LINE_BYTES) {
            this.protocolError = "worker protocol line exceeded the 16 MiB limit";
            return;
        }
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            this.parse(line);
            newline = this.buffer.indexOf("\n");
        }
    }
    parse(line) {
        if (line.trim().length === 0)
            return;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            this.protocolError = "invalid JSONL on the dispatch channel";
            return;
        }
        if (typeof parsed === "object" && parsed !== null && "type" in parsed)
            this.onMessage(parsed);
    }
    /** Synchronous enqueue on the socket: messages keep their call order (board_post FIFO). */
    send(message) {
        if (!this.stream.writable)
            return false;
        try {
            this.stream.write(`${JSON.stringify(message)}\n`);
            return true;
        }
        catch {
            return false;
        }
    }
    end() {
        try {
            this.stream.end();
        }
        catch { /* closed */ }
    }
    /** End our side and stop the socket from holding the process open. */
    release() {
        this.end();
        this.stream.unref?.();
    }
}
/** Preserve worker control tools (`report_progress` / `board_*`) when an explicit `tools` allowlist is set. */
export function resolveWorkerTools(capsule) {
    if (capsule.tools === undefined)
        return undefined;
    if (capsule.tools.some((entry) => entry.startsWith("+") || entry.startsWith("-")))
        return [...capsule.tools];
    const excluded = new Set(capsule.excludeTools ?? []);
    const required = capsule.role === "peer-worker" ? ["board_post", "board_read", "board_wait"] : ["report_progress"];
    const extras = required.filter((name) => !capsule.tools.includes(name) && !excluded.has(name));
    return extras.length === 0 ? [...capsule.tools] : [...capsule.tools, ...extras];
}
//# sourceMappingURL=protocol.js.map