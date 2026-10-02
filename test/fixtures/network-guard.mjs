// Preload (`node --import`) for runs that deliberately leave mmp online: any outgoing connection
// is refused and recorded in MMP_NETWORK_GUARD_OUT, so a test can both stay offline and assert
// nothing tried to connect.
import { appendFileSync } from "node:fs";
import net from "node:net";

const out = process.env.MMP_NETWORK_GUARD_OUT;
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
  // Local IPC (a pipe path) is not network.
  if (options.path !== undefined) return connect.apply(this, args);
  refuse(`connect ${options.host ?? "localhost"}:${options.port}`);
};
