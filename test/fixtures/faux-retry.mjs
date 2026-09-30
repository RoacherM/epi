// Faux model for auto-retry (dogfood D17): every request fails with "529 overloaded", which Pi
// classifies as retryable, so after the first one it waits out settings.retry.baseDelayMs
// ("Retrying (1/N)…") before trying again. Each error takes a moment, so the running status is
// drawn before the backoff starts.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { pause, registerFaux } from "./faux-register.mjs";

export default function (pi) {
  const overloaded = async (_context, options) => {
    await pause(300, options?.signal);
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" });
  };
  registerFaux(pi, { models: ["compactor"], responses: [overloaded, overloaded, overloaded, overloaded] });
}
