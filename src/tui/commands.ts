// /login, /logout, /model (docs/tui-design.md 4.6); registered in builtins.ts.
// The flows follow Pi's interactive mode, built from the components Pi exports.
import {
  type AgentSession,
  CredentialSynchronizationError,
  ExtensionSelectorComponent,
  LoginDialogComponent,
  ModelSelectorComponent,
  OAuthSelectorComponent,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

import type { CommandHost } from "./command-host.js";
import { errorText } from "./errors.js";
import { resolveMmpPaths } from "../paths.js";
import { findNearestProjectManifest } from "../project.js";
import { projectTrustOptions, saveProjectTrustChoice } from "../trust-prompt.js";

type Model = NonNullable<AgentSession["model"]>;
type LoginOption = ConstructorParameters<typeof OAuthSelectorComponent>[1][number];
type AuthPrompt = { type: string; message: string; placeholder?: string; options?: { id: string; label: string }[]; signal?: AbortSignal };
type AuthEvent = { type: string; url?: string; instructions?: string; message?: string; links?: never } & Record<string, unknown>;

const CANCELLED = "Login cancelled";

/** Pi keeps a placeholder model when nothing usable is configured. */
function needsModel(session: AgentSession): boolean {
  const model = session.model;
  return model === undefined || model.provider === "unknown" ||
    !session.modelRuntime.getAvailableSnapshot().some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
}

function loginOptions(session: AgentSession): LoginOption[] {
  const runtime = session.modelRuntime;
  const options: LoginOption[] = [];
  for (const provider of runtime.getProviders()) {
    const auth = runtime.getProviderAuthStatus(provider.id);
    const status = auth.configured
      ? { type: runtime.isUsingOAuth(provider.id) ? "oauth" as const : "api_key" as const, source: auth.label ?? auth.source ?? "" }
      : undefined;
    // Pi's selector says "subscription" unless this is false (Pi 1.0: other OAuth sign-ins say "account").
    const subscription = provider.auth.oauth?.isSubscription === true;
    if (provider.auth.oauth) {
      options.push({ id: provider.id, name: provider.name, authType: "oauth", method: provider.auth.oauth, subscription, ...(status ? { status } : {}) } as LoginOption);
    }
    if (provider.auth.apiKey) {
      options.push({ id: provider.id, name: provider.name, authType: "api_key", method: provider.auth.apiKey, subscription, ...(status ? { status } : {}) } as LoginOption);
    }
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

const ACCOUNT_LABEL = "Sign in with an account";
const API_KEY_LABEL = "Sign in with an API key";

/** Like Pi: first the method (account or API key), then the providers offering it. */
export async function runLogin(host: CommandHost, providerRef: string): Promise<void> {
  const all = loginOptions(host.session());
  const ref = providerRef.trim().toLowerCase();
  const matches = ref === "" ? [] : all.filter((option) => option.id.toLowerCase() === ref || option.name.toLowerCase() === ref);
  if (matches.length === 1 && matches[0] !== undefined) {
    await startLogin(host, matches[0]);
    return;
  }
  const candidates = matches.length > 0 ? matches : all;
  const types = new Set(candidates.map((option) => option.authType));
  if (types.size === 0) {
    host.notice("No login providers available.", "warning");
    return;
  }
  const authType = types.size === 1 ? [...types][0] : await chooseAuthType(host, matches[0]?.name);
  if (authType === undefined) return;
  const options = candidates.filter((option) => option.authType === authType);
  if (matches.length > 0 && options.length === 1 && options[0] !== undefined) {
    await startLogin(host, options[0], () => runLogin(host, providerRef));
    return;
  }
  await chooseProvider(host, options, matches.length > 0 ? undefined : providerRef.trim());
}

function chooseAuthType(host: CommandHost, providerName: string | undefined): Promise<LoginOption["authType"] | undefined> {
  return new Promise((resolve) => {
    let restore: () => void = () => {};
    const title = providerName === undefined ? "Select authentication method:" : `Select authentication method for ${providerName}:`;
    const selector = new ExtensionSelectorComponent(title, [ACCOUNT_LABEL, API_KEY_LABEL], (choice) => {
      restore();
      resolve(choice === ACCOUNT_LABEL ? "oauth" : "api_key");
    }, () => {
      restore();
      resolve(undefined);
    });
    restore = host.takeEditorSlot(selector);
  });
}

async function chooseProvider(host: CommandHost, options: LoginOption[], search: string | undefined): Promise<void> {
  if (options.length === 0) {
    host.notice("No providers offer this login method.", "warning");
    return;
  }
  const ref = search ?? "";
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selector = new OAuthSelectorComponent("login", options, (providerId, authType) => {
      restore();
      const option = options.find((candidate) => candidate.id === providerId && candidate.authType === authType);
      void (option === undefined ? Promise.resolve() : startLogin(host, option, () => chooseProvider(host, options, search))).then(resolve);
    }, () => {
      restore();
      resolve();
    }, ref === "" ? undefined : ref);
    restore = host.takeEditorSlot(selector);
  });
}

/** `onBack` reopens the selector the login was started from when the user cancels it (Pi 1.0's
 * startProviderLogin). */
async function startLogin(host: CommandHost, option: LoginOption, onBack?: () => Promise<void>): Promise<void> {
  const method = option.method as { login?: unknown; name?: string } | undefined;
  if (option.authType === "api_key" && method?.login === undefined) {
    host.notice(`${option.name}: ${method?.name ?? "authentication"} is configured outside MMP (environment or models.json).`, "warning");
    return;
  }
  const session = host.session();
  const previousModelMissing = needsModel(session);
  const dialog = new LoginDialogComponent(host.tui, option.id, () => {}, option.name);
  const restoreEditor = host.takeEditorSlot(dialog);
  try {
    await session.modelRuntime.login(option.id, option.authType, {
      signal: dialog.signal,
      prompt: (prompt: AuthPrompt) => authPrompt(host, dialog, prompt),
      notify: (event: AuthEvent) => authNotify(dialog, event),
    } as never);
    restoreEditor();
  } catch (error) {
    restoreEditor();
    const message = errorText(error);
    if (error instanceof CredentialSynchronizationError) {
      host.notice(`Logged in to ${option.name}, but local model state could not be synchronized: ${message}`, "error");
    } else if (message === CANCELLED || dialog.signal.aborted) {
      // The dialog's Esc aborts its signal before rejecting the prompt, and pi-ai's Models.login
      // races the login against that signal, so a cancel usually arrives as "This operation was
      // aborted" rather than CANCELLED. Either way the user cancelled: nothing failed.
      await onBack?.();
    } else {
      host.notice(`Login to ${option.name} failed: ${message}`, "error");
    }
    return;
  }
  const done = option.authType === "oauth" ? `Logged in to ${option.name}` : `Saved API key for ${option.name}`;
  // Dynamic catalogs may be empty until the first authenticated refresh.
  const refresh = await session.modelRuntime
    .refresh({ providers: [option.id], signal: AbortSignal.timeout(15_000) })
    .catch((error: unknown) => ({ aborted: false, errors: new Map([[option.id, error]]) }));
  if (refresh.aborted || refresh.errors.size > 0) {
    host.notice(`${done}, but its model catalog could not be refreshed; using cached models.`, "warning");
  }
  if (previousModelMissing) {
    // Pi picks a per-provider default from a table it does not export; MMP asks instead.
    await runModel(host, option.id, { persist: true, title: `${done}. Pick a model:` });
  } else {
    host.notice(`${done}.`);
  }
}

function authPrompt(host: CommandHost, dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
  let response: Promise<string>;
  if (prompt.type === "select" && prompt.options !== undefined) {
    const choices = prompt.options;
    response = new Promise((resolve, reject) => {
      const selector = new ExtensionSelectorComponent(prompt.message, choices.map((choice) => choice.label), (label) => {
        host.takeEditorSlot(dialog);
        const id = choices.find((choice) => choice.label === label)?.id;
        if (id === undefined) reject(new Error(CANCELLED));
        else resolve(id);
      }, () => {
        host.takeEditorSlot(dialog);
        reject(new Error(CANCELLED));
      });
      host.takeEditorSlot(selector);
    });
  } else if (prompt.type === "manual_code") {
    response = dialog.showManualInput(prompt.message);
  } else {
    response = dialog.showPrompt(prompt.message, prompt.placeholder);
  }
  const signal = prompt.signal;
  if (signal === undefined) return response;
  if (signal.aborted) return Promise.reject(new Error(CANCELLED));
  return Promise.race([
    response,
    new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(CANCELLED)), { once: true })),
  ]);
}

function authNotify(dialog: LoginDialogComponent, event: AuthEvent): void {
  if (event.type === "auth_url" && typeof event.url === "string") {
    dialog.showAuth(event.url, event.instructions);
  } else if (event.type === "device_code") {
    dialog.showDeviceCode(event as never);
    dialog.showWaiting("Waiting for authentication...");
  } else if (event.type === "info") {
    dialog.showInfo(event.message ?? "", event.links);
  } else {
    dialog.showProgress(event.message ?? "");
  }
}

export async function runLogout(host: CommandHost): Promise<void> {
  const runtime = host.session().modelRuntime;
  let credentials: { providerId: string; type: "oauth" | "api_key" }[];
  try {
    credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) }) as typeof credentials;
  } catch (error) {
    host.notice(`Could not read stored credentials: ${errorText(error)}`, "error");
    return;
  }
  if (credentials.length === 0) {
    host.notice("No stored credentials to remove. /logout only removes credentials saved by /login.");
    return;
  }
  const options = credentials
    .map(({ providerId, type }) => ({
      id: providerId,
      name: runtime.getProvider(providerId)?.name ?? providerId,
      authType: type,
      status: { type, source: "stored credential" },
      subscription: runtime.getProvider(providerId)?.auth.oauth?.isSubscription === true,
    }) as LoginOption)
    .sort((a, b) => a.name.localeCompare(b.name));
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selector = new OAuthSelectorComponent("logout", options, (providerId) => {
      restore();
      const option = options.find((candidate) => candidate.id === providerId);
      if (option === undefined) {
        resolve();
        return;
      }
      void runtime.logout(option.id, { signal: AbortSignal.timeout(15_000) })
        .then(() => host.notice(option.authType === "oauth" ? `Logged out of ${option.name}.` : `Removed stored API key for ${option.name}.`))
        .catch((error: unknown) => host.notice(`Logout failed: ${errorText(error)}`, "error"))
        .finally(resolve);
    }, () => {
      restore();
      resolve();
    });
    restore = host.takeEditorSlot(selector);
  });
}

/** `/model [query]`: switch directly on an exact match, otherwise open the selector. */
export async function runModel(
  host: CommandHost,
  query: string,
  options: { persist?: boolean; title?: string } = {},
): Promise<void> {
  const session = host.session();
  const trimmed = query.trim();
  if (trimmed !== "" && options.title === undefined) {
    const exact = resolveCliModel({ cliModel: trimmed, modelRuntime: session.modelRuntime });
    if (exact.model !== undefined && exact.error === undefined) {
      await selectModel(host, exact.model, options.persist ?? false);
      return;
    }
  }
  if (options.title !== undefined) host.notice(options.title);
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const finish = (model: Model | undefined, persist: boolean) => {
      restore();
      selector.dispose();
      void (model === undefined ? Promise.resolve() : selectModel(host, model, persist)).then(resolve);
    };
    const selector = new ModelSelectorComponent(
      host.tui,
      session.model,
      session.modelRuntime,
      session.scopedModels,
      (model) => finish(model, options.persist ?? false),
      () => finish(undefined, false),
      trimmed === "" ? undefined : trimmed,
      (model) => finish(model, true),
    );
    restore = host.takeEditorSlot(selector);
  });
}

/** `/trust`: same options and store as the first-run prompt (src/trust-prompt.ts), for the current project root. */
export async function runTrust(host: CommandHost): Promise<void> {
  const candidate = findNearestProjectManifest(host.cwd, resolveMmpPaths(process.env).globalManifest);
  if (candidate === undefined) {
    host.notice("No .mmp/mmp.json project found from the current directory.", "warning");
    return;
  }
  const choices = projectTrustOptions(candidate.root);
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selector = new ExtensionSelectorComponent(
      "Trust project folder?",
      choices.map((choice) => choice.label),
      (label) => {
        restore();
        const choice = choices.find((option) => option.label === label);
        if (choice !== undefined) {
          if (choice.updates.length > 0) {
            saveProjectTrustChoice(host.agentDir, choice);
            host.notice(`Saved: ${choice.label}. Takes effect after restarting mmp (manifest extensions cannot be hot-loaded).`);
          } else {
            host.notice(`${choice.label}: not saved.`);
          }
        }
        resolve();
      },
      () => {
        restore();
        resolve();
      },
      {
        description: `${candidate.root}\n` +
          "This lets MMP read .mmp/mmp.json and load its rules, skills and extensions (extensions run code).",
      },
    );
    restore = host.takeEditorSlot(selector);
  });
}

async function selectModel(host: CommandHost, model: Model, persist: boolean): Promise<void> {
  try {
    await host.session().setModel(model, { persist });
    host.notice(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.provider}/${model.id}`);
  } catch (error) {
    host.notice(`Could not switch to ${model.provider}/${model.id}: ${errorText(error)}`, "error");
  }
}
