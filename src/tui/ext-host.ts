// ExtensionUIContext for MMP's host: all members exist (docs/tui-design.md 6.1). Members the v0
// layout cannot place yet report that plainly instead of silently doing nothing.
import {
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, TUI } from "@earendil-works/pi-tui";

import { piTui } from "./pi-tui.js";

/** What the extension host may do to the screen; implemented by the app. */
export interface HostSurface {
  readonly tui: TUI;
  readonly theme: Theme;
  /** Put a component where the editor is and focus it; returns a function restoring the editor. */
  takeEditorSlot(component: Component): () => void;
  setHeader(component: Component | undefined): void;
  setFooter(component: Component | undefined): void;
  setWidget(key: string, component: Component | undefined, placement: "aboveEditor" | "belowEditor"): void;
  setStatus(key: string, text: string | undefined): void;
  setWorking(options: { message?: string | undefined; visible?: boolean | undefined }): void;
  setTitle(title: string): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  getAutocompleteProvider(): AutocompleteProvider;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
  notify(message: string, tone: "info" | "warning" | "error"): void;
}

type DialogOptions = { signal?: AbortSignal; timeout?: number } | undefined;

function unsupported(surface: HostSurface, member: string): void {
  surface.notify(`An extension called ui.${member}, which MMP TUI v2 does not support yet.`, "warning");
}

export function createExtensionUIContext(surface: HostSurface): ExtensionUIContext {
  /** Show a dialog in the editor slot; resolves with `fallback` on cancel, abort, or timeout. */
  function dialog<T>(build: (done: (value: T) => void) => Component, fallback: T, options: DialogOptions): Promise<T> {
    return new Promise((resolve) => {
      let settled = false;
      let restore: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      const done = (value: T) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        restore?.();
        resolve(value);
      };
      const onAbort = () => done(fallback);
      if (options?.signal?.aborted) {
        resolve(fallback);
        return;
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.timeout !== undefined) timer = setTimeout(onAbort, options.timeout);
      restore = surface.takeEditorSlot(build(done));
    });
  }

  const ui: ExtensionUIContext = {
    select: (title, options, opts) =>
      dialog<string | undefined>((done) => new ExtensionSelectorComponent(title, options, done, () => done(undefined)), undefined, opts),
    confirm: (title, message, opts) =>
      dialog<boolean>(
        (done) => new ExtensionSelectorComponent(`${title}\n${message}`, ["Yes", "No"], (choice) => done(choice === "Yes"), () => done(false)),
        false,
        opts,
      ),
    input: (title, placeholder, opts) =>
      dialog<string | undefined>((done) => new ExtensionInputComponent(title, placeholder, done, () => done(undefined)), undefined, opts),
    editor: (title, prefill) =>
      dialog<string | undefined>(
        (done) => new ExtensionEditorComponent(
          surface.tui,
          // Pi's app-level KeybindingsManager, installed as pi-tui's global map by keybindings.ts.
          piTui.getKeybindings() as never,
          title,
          prefill,
          done,
          () => done(undefined),
        ),
        undefined,
        undefined,
      ),
    notify: (message, type) => surface.notify(message, type ?? "info"),
    onTerminalInput: (handler) => surface.tui.addInputListener(handler),
    setStatus: (key, text) => surface.setStatus(key, text),
    setWorkingMessage: (message) => surface.setWorking({ message }),
    setWorkingVisible: (visible) => surface.setWorking({ visible }),
    setWorkingIndicator: () => unsupported(surface, "setWorkingIndicator"),
    setHiddenThinkingLabel: () => unsupported(surface, "setHiddenThinkingLabel"),
    setWidget: ((key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
      const placement = options?.placement ?? "aboveEditor";
      if (content === undefined) {
        surface.setWidget(key, undefined, placement);
      } else if (Array.isArray(content)) {
        surface.setWidget(key, new piTui.Text(content.join("\n"), 1, 0), placement);
      } else {
        surface.setWidget(key, (content as (tui: TUI, theme: Theme) => Component)(surface.tui, surface.theme), placement);
      }
    }) as ExtensionUIContext["setWidget"],
    setFooter: (factory) => {
      surface.setFooter(factory === undefined ? undefined : factory(surface.tui, surface.theme, {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 0,
        onBranchChange: () => () => {},
      }));
    },
    setHeader: (factory) => surface.setHeader(factory === undefined ? undefined : factory(surface.tui, surface.theme)),
    setTitle: (title) => surface.setTitle(title),
    custom: (factory, options) =>
      new Promise((resolve) => {
        let finished = false;
        let finish: (() => void) | undefined;
        const component = factory(surface.tui, surface.theme, piTui.getKeybindings() as never, (result) => {
          if (finished) return;
          finished = true;
          finish?.();
          resolve(result);
        });
        void Promise.resolve(component).then((resolved) => {
          // done() may run before the component is mounted; mounting it then would wedge the editor slot.
          if (finished) return;
          if (options?.overlay) {
            const overlayOptions = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            const handle = surface.tui.showOverlay(resolved, overlayOptions);
            options.onHandle?.(handle);
            finish = () => handle.hide();
          } else {
            finish = surface.takeEditorSlot(resolved);
          }
        });
      }),
    pasteToEditor: (text) => surface.setEditorText(surface.getEditorText() + text),
    setEditorText: (text) => surface.setEditorText(text),
    getEditorText: () => surface.getEditorText(),
    addAutocompleteProvider: (factory) => surface.setAutocompleteProvider(factory(surface.getAutocompleteProvider())),
    setEditorComponent: (factory) => {
      if (factory !== undefined) unsupported(surface, "setEditorComponent");
    },
    getEditorComponent: () => undefined,
    get theme() {
      return surface.theme;
    },
    getAllThemes: () => [{ name: surface.theme.name ?? "mmp", path: undefined }],
    getTheme: (name) => (name === surface.theme.name ? surface.theme : undefined),
    setTheme: () => ({ success: false, error: "MMP TUI v2 uses its own grok theme; switching is not supported yet." }),
    getToolsExpanded: () => surface.getToolsExpanded(),
    setToolsExpanded: (expanded) => surface.setToolsExpanded(expanded),
  };
  return ui;
}
