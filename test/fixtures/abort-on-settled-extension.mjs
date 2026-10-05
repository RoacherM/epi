// Calls ctx.abort() from its own agent_settled handler. Pi awaits extension handlers for that
// event after the run is over but before Epi draws the footer, so there is nothing left to stop
// and the run that finished normally must still read "Worked for" (dogfood D37).
export default function (pi) {
  pi.on("agent_settled", (_event, ctx) => {
    ctx.abort();
  });
}
