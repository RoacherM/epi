// Two native providers for /login tests, neither of which touches the network or a browser.
// - "Device Probe": its OAuth login fails at once with the device ID it was given (pi-ai's
//   LoginOptions.getDeviceId), the way "Sign in with ChatGPT" needs one before it starts.
// - "Ambient Probe": an API-key method without login(), i.e. credentials configured outside
//   the app (Pi's showAmbientAuthDialog path).
export default function (pi) {
  pi.registerProvider({
    id: "mmp-device-probe",
    name: "Device Probe",
    auth: {
      oauth: {
        name: "Device Probe account",
        async login(_interaction, options) {
          throw new Error(`DEVICE-ID=${options?.getDeviceId?.() ?? "missing"}`);
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth() {
          return {};
        },
      },
    },
    getModels: () => [],
  });
  pi.registerProvider({
    id: "mmp-ambient-probe",
    name: "Ambient Probe",
    auth: {
      apiKey: {
        name: "Ambient Probe credentials",
        async resolve() {
          return undefined;
        },
      },
    },
    getModels: () => [],
  });
}
