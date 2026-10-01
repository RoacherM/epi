// Delays session_start (which app.ts's bind() awaits via session.bindExtensions()) so a test can
// type into the editor while startup is still in flight, deterministically instead of racing real
// timing. Pairs with faux-two-models.mjs for a model to answer with.
export default function (pi) {
  pi.on("session_start", async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}
