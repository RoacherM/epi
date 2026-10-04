// An extension that writes to stdout at every stage. In print/json/rpc stdout belongs to the mode's
// own output, so all of this has to end up on stderr.
export default function (pi) {
  console.log("NOISE-factory-console.log");
  process.stdout.write("NOISE-factory-stdout.write\n");
  pi.on("session_start", () => { console.log("NOISE-session_start"); });
  pi.on("agent_end", () => { console.log("NOISE-agent_end"); });
  pi.on("session_shutdown", () => { console.log("NOISE-session_shutdown"); });
}
