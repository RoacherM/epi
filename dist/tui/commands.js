// /login, /logout, /model (docs/tui-design.md 4.6); registered in builtins.ts.
// The flows follow Pi's interactive mode, built from the components Pi exports.
import { CredentialSynchronizationError, ExtensionSelectorComponent, LoginDialogComponent, ModelSelectorComponent, OAuthSelectorComponent, resolveCliModel, } from "@earendil-works/pi-coding-agent";
const CANCELLED = "Login cancelled";
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Pi keeps a placeholder model when nothing usable is configured. */
function needsModel(session) {
    const model = session.model;
    return model === undefined || model.provider === "unknown" ||
        !session.modelRuntime.getAvailableSnapshot().some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
}
function loginOptions(session) {
    const runtime = session.modelRuntime;
    const options = [];
    for (const provider of runtime.getProviders()) {
        const auth = runtime.getProviderAuthStatus(provider.id);
        const status = auth.configured
            ? { type: runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key", source: auth.label ?? auth.source ?? "" }
            : undefined;
        if (provider.auth.oauth) {
            options.push({ id: provider.id, name: provider.name, authType: "oauth", method: provider.auth.oauth, ...(status ? { status } : {}) });
        }
        if (provider.auth.apiKey) {
            options.push({ id: provider.id, name: provider.name, authType: "api_key", method: provider.auth.apiKey, ...(status ? { status } : {}) });
        }
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
}
const ACCOUNT_LABEL = "Sign in with an account (subscription)";
const API_KEY_LABEL = "Sign in with an API key";
/** Like Pi: first the method (account or API key), then the providers offering it. */
export async function runLogin(host, providerRef) {
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
    if (authType === undefined)
        return;
    const options = candidates.filter((option) => option.authType === authType);
    if (matches.length > 0 && options.length === 1 && options[0] !== undefined) {
        await startLogin(host, options[0]);
        return;
    }
    await chooseProvider(host, options, matches.length > 0 ? undefined : providerRef.trim());
}
function chooseAuthType(host, providerName) {
    return new Promise((resolve) => {
        let restore = () => { };
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
async function chooseProvider(host, options, search) {
    if (options.length === 0) {
        host.notice("No providers offer this login method.", "warning");
        return;
    }
    const ref = search ?? "";
    await new Promise((resolve) => {
        let restore = () => { };
        const selector = new OAuthSelectorComponent("login", options, (providerId, authType) => {
            restore();
            const option = options.find((candidate) => candidate.id === providerId && candidate.authType === authType);
            void (option === undefined ? Promise.resolve() : startLogin(host, option)).then(resolve);
        }, () => {
            restore();
            resolve();
        }, ref === "" ? undefined : ref);
        restore = host.takeEditorSlot(selector);
    });
}
async function startLogin(host, option) {
    const method = option.method;
    if (option.authType === "api_key" && method?.login === undefined) {
        host.notice(`${option.name}: ${method?.name ?? "authentication"} is configured outside MMP (environment or models.json).`, "warning");
        return;
    }
    const session = host.session();
    const previousModelMissing = needsModel(session);
    const dialog = new LoginDialogComponent(host.tui, option.id, () => { }, option.name);
    const restoreEditor = host.takeEditorSlot(dialog);
    try {
        await session.modelRuntime.login(option.id, option.authType, {
            signal: dialog.signal,
            prompt: (prompt) => authPrompt(host, dialog, prompt),
            notify: (event) => authNotify(dialog, event),
        });
        restoreEditor();
    }
    catch (error) {
        restoreEditor();
        const message = errorText(error);
        if (error instanceof CredentialSynchronizationError) {
            host.notice(`Logged in to ${option.name}, but local model state could not be synchronized: ${message}`, "error");
        }
        else if (message !== CANCELLED) {
            host.notice(`Login to ${option.name} failed: ${message}`, "error");
        }
        return;
    }
    const done = option.authType === "oauth" ? `Logged in to ${option.name}` : `Saved API key for ${option.name}`;
    // Dynamic catalogs may be empty until the first authenticated refresh.
    const refresh = await session.modelRuntime
        .refresh({ providers: [option.id], signal: AbortSignal.timeout(15_000) })
        .catch((error) => ({ aborted: false, errors: new Map([[option.id, error]]) }));
    if (refresh.aborted || refresh.errors.size > 0) {
        host.notice(`${done}, but its model catalog could not be refreshed; using cached models.`, "warning");
    }
    if (previousModelMissing) {
        // Pi picks a per-provider default from a table it does not export; MMP asks instead.
        await runModel(host, option.id, { persist: true, title: `${done}. Pick a model:` });
    }
    else {
        host.notice(`${done}.`);
    }
}
function authPrompt(host, dialog, prompt) {
    let response;
    if (prompt.type === "select" && prompt.options !== undefined) {
        const choices = prompt.options;
        response = new Promise((resolve, reject) => {
            const selector = new ExtensionSelectorComponent(prompt.message, choices.map((choice) => choice.label), (label) => {
                host.takeEditorSlot(dialog);
                const id = choices.find((choice) => choice.label === label)?.id;
                if (id === undefined)
                    reject(new Error(CANCELLED));
                else
                    resolve(id);
            }, () => {
                host.takeEditorSlot(dialog);
                reject(new Error(CANCELLED));
            });
            host.takeEditorSlot(selector);
        });
    }
    else if (prompt.type === "manual_code") {
        response = dialog.showManualInput(prompt.message);
    }
    else {
        response = dialog.showPrompt(prompt.message, prompt.placeholder);
    }
    const signal = prompt.signal;
    if (signal === undefined)
        return response;
    if (signal.aborted)
        return Promise.reject(new Error(CANCELLED));
    return Promise.race([
        response,
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(CANCELLED)), { once: true })),
    ]);
}
function authNotify(dialog, event) {
    if (event.type === "auth_url" && typeof event.url === "string") {
        dialog.showAuth(event.url, event.instructions);
    }
    else if (event.type === "device_code") {
        dialog.showDeviceCode(event);
        dialog.showWaiting("Waiting for authentication...");
    }
    else if (event.type === "info") {
        dialog.showInfo(event.message ?? "", event.links);
    }
    else {
        dialog.showProgress(event.message ?? "");
    }
}
export async function runLogout(host) {
    const runtime = host.session().modelRuntime;
    let credentials;
    try {
        credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
    }
    catch (error) {
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
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
    await new Promise((resolve) => {
        let restore = () => { };
        const selector = new OAuthSelectorComponent("logout", options, (providerId) => {
            restore();
            const option = options.find((candidate) => candidate.id === providerId);
            if (option === undefined) {
                resolve();
                return;
            }
            void runtime.logout(option.id, { signal: AbortSignal.timeout(15_000) })
                .then(() => host.notice(option.authType === "oauth" ? `Logged out of ${option.name}.` : `Removed stored API key for ${option.name}.`))
                .catch((error) => host.notice(`Logout failed: ${errorText(error)}`, "error"))
                .finally(resolve);
        }, () => {
            restore();
            resolve();
        });
        restore = host.takeEditorSlot(selector);
    });
}
/** `/model [query]`: switch directly on an exact match, otherwise open the selector. */
export async function runModel(host, query, options = {}) {
    const session = host.session();
    const trimmed = query.trim();
    if (trimmed !== "" && options.title === undefined) {
        const exact = resolveCliModel({ cliModel: trimmed, modelRuntime: session.modelRuntime });
        if (exact.model !== undefined && exact.error === undefined) {
            await selectModel(host, exact.model, options.persist ?? false);
            return;
        }
    }
    if (options.title !== undefined)
        host.notice(options.title);
    await new Promise((resolve) => {
        let restore = () => { };
        const finish = (model, persist) => {
            restore();
            selector.dispose();
            void (model === undefined ? Promise.resolve() : selectModel(host, model, persist)).then(resolve);
        };
        const selector = new ModelSelectorComponent(host.tui, session.model, session.modelRuntime, session.scopedModels, (model) => finish(model, options.persist ?? false), () => finish(undefined, false), trimmed === "" ? undefined : trimmed, (model) => finish(model, true));
        restore = host.takeEditorSlot(selector);
    });
}
async function selectModel(host, model, persist) {
    try {
        await host.session().setModel(model, { persist });
        host.notice(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.provider}/${model.id}`);
    }
    catch (error) {
        host.notice(`Could not switch to ${model.provider}/${model.id}: ${errorText(error)}`, "error");
    }
}
//# sourceMappingURL=commands.js.map