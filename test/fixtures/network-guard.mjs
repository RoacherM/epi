// Preload (`node --import`) for runs that deliberately leave epi online: the main thread's `fetch`
// and TCP/TLS connects (net, tls, http, https) are refused and recorded in EPI_NETWORK_GUARD_OUT,
// so a test can both stay offline and assert nothing tried to connect. Not covered: child
// processes, worker threads, UDP and DNS lookups (test/pi-env.test.mjs checks the guard itself).
import { appendFileSync } from "node:fs";
import net from "node:net";

const out = process.env.EPI_NETWORK_GUARD_OUT;
function refuse(what) {
  appendFileSync(out, `${what}\n`);
  throw new Error(`network-guard: ${what} refused`);
}

globalThis.fetch = async (input) => refuse(`fetch ${input instanceof Request ? input.url : String(input)}`);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() passes its normalized [options, callback] array as the first argument.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null ? first : { port: first, host: args[1] };
  // Local IPC (a pipe path) is not network. http's agent passes `path: null` for TCP, so check the type.
  if (typeof options.path === "string") return connect.apply(this, args);
  refuse(`connect ${options.host ?? "localhost"}:${options.port}`);
};
