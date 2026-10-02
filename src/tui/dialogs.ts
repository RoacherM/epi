// Dialogs shown in the editor slot, for extensions (ext-host.ts) and built-in commands alike.
// Built from the components Pi's own extension dialogs use (interactive-mode.js showExtension*).
import { ExtensionEditorComponent, ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { piTui } from "./pi-tui.js";

/** The part of HostSurface / CommandHost a dialog needs. */
interface EditorSlotHost {
  readonly tui: TUI;
  /** Shows `component` in the editor slot; the returned function gives the editor back, focus included. */
  takeEditorSlot(component: Component): () => void;
}

export type DialogOptions = { signal?: AbortSignal; timeout?: number } | undefined;

/** Show a dialog in the editor slot; resolves with `fallback` on cancel, abort, or timeout. `done`
 * restores the editor before resolving, so code running after it in a component callback already
 * sees the editor back. */
export function dialog<T>(
  host: EditorSlotHost,
  build: (done: (value: T) => void) => Component,
  fallback: T,
  options?: DialogOptions,
): Promise<T> {
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
    restore = host.takeEditorSlot(build(done));
  });
}

/** Pick one of `labels`; undefined on cancel. */
export function selectInEditorSlot(host: EditorSlotHost, title: string, labels: string[], options?: DialogOptions): Promise<string | undefined> {
  return dialog<string | undefined>(host, (done) => new ExtensionSelectorComponent(title, labels, done, () => done(undefined)), undefined, options);
}

/** Yes/No; false on cancel. */
export function confirmInEditorSlot(host: EditorSlotHost, title: string, message: string, options?: DialogOptions): Promise<boolean> {
  return dialog<boolean>(
    host,
    (done) => new ExtensionSelectorComponent(`${title}\n${message}`, ["Yes", "No"], (choice) => done(choice === "Yes"), () => done(false)),
    false,
    options,
  );
}

/** Multi-line text; undefined on cancel. */
export function editInEditorSlot(host: EditorSlotHost, title: string, prefill: string | undefined): Promise<string | undefined> {
  return dialog<string | undefined>(
    host,
    (done) => new ExtensionEditorComponent(
      host.tui,
      // Pi's app-level KeybindingsManager, installed as pi-tui's global map by keybindings.ts.
      piTui.getKeybindings() as never,
      title,
      prefill,
      done,
      () => done(undefined),
    ),
    undefined,
  );
}
