// ExtensionUIContext for Epi's host: all members exist (docs/tui-design.md 6.1). Members the v0
// layout cannot place yet report that plainly instead of silently doing nothing.
import { ExtensionInputComponent, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, TUI } from "@earendil-works/pi-tui";

import { confirmInEditorSlot, dialog, editInEditorSlot, selectInEditorSlot } from "./dialogs.js";
import type { StatusLineFormatter } from "./chrome.js";
import { piTui } from "./pi-tui.js";

/** What the extension host may do to the screen; implemented by the app. */
export interface HostSurface {
  readonly tui: TUI;
  readonly theme: Theme;
  /** Put a component where the editor is and focus it (or `focus`, for a component whose own
   * keyboard handling lives on a child); returns a function restoring the editor. */
  takeEditorSlot(component: Component, focus?: Component): () => void;
  setHeader(component: Component | undefined): void;
  setFooter(component: Component | undefined): void;
  setWidget(key: string, component: Component | undefined, placement: "aboveEditor" | "belowEditor"): void;
  setStatus(key: string, text: string | undefined): void;
  /** Replace the prompt frame's bottom-right label formatter; undefined restores the built-in. */
  setStatusLine(formatter: StatusLineFormatter | undefined): void;
  setWorking(options: { message?: string | undefined; visible?: boolean | undefined }): void;
  setTitle(title: string): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  /** Pi's addAutocompleteProvider: keep the wrapper and re-apply it on every autocomplete rebuild. */
  addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
  notify(message: string, tone: "info" | "warning" | "error"): void;
}

/** Epi's addition on top of Pi's ExtensionUIContext (docs/statusbar-design.md §3): the prompt
 * frame's bottom-right label is a slot any extension can reformat; `setStatusLine(undefined)`
 * restores the built-in default. */
export interface EpiExtensionUIContext extends ExtensionUIContext {
  setStatusLine(format: StatusLineFormatter | undefined): void;
}

function unsupported(surface: HostSurface, member: string): void {
  surface.notify(`An extension called ui.${member}, which Epi TUI v2 does not support yet.`, "warning");
}

export function createExtensionUIContext(surface: HostSurface): EpiExtensionUIContext {
  const ui: EpiExtensionUIContext = {
    select: (title, options, opts) => selectInEditorSlot(surface, title, options, opts),
    confirm: (title, message, opts) => confirmInEditorSlot(surface, title, message, opts),
    input: (title, placeholder, opts) =>
      dialog<string | undefined>(surface, (done) => new ExtensionInputComponent(title, placeholder, done, () => done(undefined)), undefined, opts),
    editor: (title, prefill) => editInEditorSlot(surface, title, prefill),
    notify: (message, type) => surface.notify(message, type ?? "info"),
    onTerminalInput: (handler) => surface.tui.addInputListener(handler),
    setStatus: (key, text) => surface.setStatus(key, text),
    setStatusLine: (format) => surface.setStatusLine(format),
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
    addAutocompleteProvider: (factory) => surface.addAutocompleteProvider(factory),
    setEditorComponent: (factory) => {
      if (factory !== undefined) unsupported(surface, "setEditorComponent");
    },
    getEditorComponent: () => undefined,
    get theme() {
      return surface.theme;
    },
    getAllThemes: () => [{ name: surface.theme.name ?? "epi", path: undefined }],
    getTheme: (name) => (name === surface.theme.name ? surface.theme : undefined),
    setTheme: () => ({ success: false, error: "Epi TUI v2 uses its own grok theme; switching is not supported yet." }),
    getToolsExpanded: () => surface.getToolsExpanded(),
    setToolsExpanded: (expanded) => surface.setToolsExpanded(expanded),
  };
  return ui;
}
