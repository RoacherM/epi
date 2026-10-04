// Forces the order behind dogfood D80, which otherwise shows only on a busy machine: the un-awaited
// refresh Pi starts when an extension registers a provider (ModelRuntime.registerNativeProvider)
// reaches its availability pass after the awaited one in createAgentSessionServices, and every
// pass is slow. Without a wait before the model is picked, the provider has no auth at that moment.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let patched = false;

export default function () {
  if (patched) return;
  patched = true;
  const refresh = ModelRuntime.prototype.refresh;
  let calls = 0;
  ModelRuntime.prototype.refresh = async function (options) {
    calls += 1;
    if (calls === 1) await sleep(60);
    return refresh.call(this, options);
  };
  const pass = ModelRuntime.prototype.runAvailabilityRefresh;
  if (typeof pass !== "function") throw new Error("ModelRuntime.runAvailabilityRefresh is gone: update this fixture");
  ModelRuntime.prototype.runAvailabilityRefresh = async function (...args) {
    await sleep(250);
    return pass.apply(this, args);
  };
}
