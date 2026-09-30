// /tree, /fork, /clone (docs/tui-design.md 4.6); registered in builtins.ts.
// Mirrors Pi's showTreeSelector, showUserMessageSelector, handleCloneCommand
// (interactive-mode.js) built from the components Pi exports.
import {
  ExtensionEditorComponent,
  ExtensionSelectorComponent,
  TreeSelectorComponent,
  UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import type { CommandHost } from "./command-host.js";
import { errorText } from "./errors.js";
import { labelStoredImages } from "./paste-chips.js";
import { piTui } from "./pi-tui.js";

/** The image parts of a user (or custom) message entry, read before /fork or /tree switches away
 * from it, so the text Pi puts back in the editor gets its images too. */
function entryImages(host: CommandHost, entryId: string): ImageContent[] {
  const entry = host.session().sessionManager.getEntry(entryId);
  const content = entry?.type === "message" && entry.message.role === "user" ? entry.message.content : entry?.type === "custom_message" ? entry.content : undefined;
  return Array.isArray(content) ? content.filter((part): part is ImageContent => part?.type === "image") : [];
}

/** `/fork`: pick a previous user message, then `runtime.fork(entryId)`. Like Pi, the original
 * text is put back in the editor so the user can edit it before resending down the new branch. */
export async function runFork(host: CommandHost): Promise<void> {
  const userMessages = host.session().getUserMessagesForForking();
  if (userMessages.length === 0) {
    host.notice("No messages to fork from.", "warning");
    return;
  }
  const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selector = new UserMessageSelectorComponent(
      userMessages.map((message) => ({ id: message.entryId, text: message.text })),
      (entryId) => {
        restore();
        const images = entryImages(host, entryId);
        void host.runtime.fork(entryId).then((result) => {
          if (result.cancelled) return;
          const text = result.selectedText ?? "";
          host.restoreEditorDraft(text, labelStoredImages(text, images));
          host.notice("Forked to new session.");
        }, (error: unknown) => host.notice(`Fork failed: ${errorText(error)}`, "error")).finally(resolve);
      },
      () => {
        restore();
        resolve();
      },
      initialSelectedId,
    );
    // Like Pi's showUserMessageSelector: this component's own handleInput lives only on its
    // inner message list, not on the outer Container.
    restore = host.takeEditorSlot(selector, selector.getMessageList());
  });
}

/** `/clone`: fork at the current leaf, staying on the same point in the conversation (Pi's
 * handleCloneCommand). Nothing to clone from yet ("Nothing to clone yet" in Pi) if there's no leaf. */
export async function runClone(host: CommandHost): Promise<void> {
  const leafId = host.session().sessionManager.getLeafId();
  if (leafId === null) {
    host.notice("Nothing to clone yet.", "warning");
    return;
  }
  try {
    const result = await host.runtime.fork(leafId, { position: "at" });
    if (result.cancelled) return;
    host.notice("Cloned to new session.");
  } catch (error) {
    host.notice(`Clone failed: ${errorText(error)}`, "error");
  }
}

const SUMMARY_CHOICES = ["No summary", "Summarize", "Summarize with custom prompt"] as const;

/** Ask whether to summarize the branch being abandoned, and for custom instructions if asked.
 * Returns undefined on cancel (Esc from either dialog), matching Pi's "re-show tree selector" loop
 * by simply letting the caller re-open /tree with the same selection. */
async function askForSummary(host: CommandHost): Promise<{ summarize: boolean; customInstructions?: string } | undefined> {
  if (host.session().settingsManager.getBranchSummarySkipPrompt()) return { summarize: false };
  while (true) {
    const choice = await new Promise<typeof SUMMARY_CHOICES[number] | undefined>((resolve) => {
      let restore: () => void = () => {};
      const selector = new ExtensionSelectorComponent(
        "Summarize branch?",
        [...SUMMARY_CHOICES],
        (label) => {
          restore();
          resolve(label as typeof SUMMARY_CHOICES[number]);
        },
        () => {
          restore();
          resolve(undefined);
        },
      );
      restore = host.takeEditorSlot(selector);
    });
    if (choice === undefined) return undefined;
    if (choice !== "Summarize with custom prompt") return { summarize: choice === "Summarize" };
    const customInstructions = await new Promise<string | undefined>((resolve) => {
      let restore: () => void = () => {};
      const editor = new ExtensionEditorComponent(
        host.tui,
        // Pi's app-level KeybindingsManager, installed as pi-tui's global map by keybindings.ts.
        piTui.getKeybindings() as never,
        "Custom summarization instructions",
        undefined,
        (value) => {
          restore();
          resolve(value);
        },
        () => {
          restore();
          resolve(undefined);
        },
      );
      restore = host.takeEditorSlot(editor);
    });
    if (customInstructions === undefined) continue; // looped back to the summary choice, like Pi
    return { summarize: true, customInstructions };
  }
}

/** `/tree`: navigate the session tree. `session.navigateTree` stays on the same AgentSession
 * instance (unlike /new, /resume, /fork), so `setRebindSession` never fires for it; the transcript
 * is replayed here with `host.resetTranscript()`, mirroring Pi's own
 * `chatContainer.clear(); renderInitialMessages()` in showTreeSelector. */
export async function runTree(host: CommandHost, initialSelectedId?: string): Promise<void> {
  const session = host.session();
  const tree = session.sessionManager.getTree();
  if (tree.length === 0) {
    host.notice("No entries in session.", "warning");
    return;
  }
  const realLeafId = session.sessionManager.getLeafId();
  const initialFilterMode = session.settingsManager.getTreeFilterMode();
  await new Promise<void>((resolve) => {
    let restore: () => void = () => {};
    const selector = new TreeSelectorComponent(
      tree,
      realLeafId,
      host.tui.terminal.rows,
      (entryId) => {
        if (entryId === session.sessionManager.getLeafId()) {
          restore();
          host.notice("Already at this point.");
          resolve();
          return;
        }
        restore();
        void navigateTo(host, entryId).finally(resolve);
      },
      () => {
        restore();
        resolve();
      },
      (entryId, label) => session.sessionManager.appendLabelChange(entryId, label),
      initialSelectedId,
      initialFilterMode,
    );
    restore = host.takeEditorSlot(selector);
  });
}

async function navigateTo(host: CommandHost, entryId: string): Promise<void> {
  const session = host.session();
  const choice = await askForSummary(host);
  if (choice === undefined) {
    await runTree(host, entryId); // re-open with the same selection, like Pi
    return;
  }
  if (session.isStreaming) {
    host.restoreQueuedMessagesToEditor();
    await session.abort();
  }
  if (session.isCompacting) {
    host.notice("Wait for the current compaction to finish before navigating the session tree.", "error");
    return;
  }
  // Esc during the summary is handled by app.interrupt (keys.ts): Pi's isCompacting covers branch
  // summaries too, and it calls abortBranchSummary() alongside abortCompaction(), as Pi's
  // showTreeSelector does with its temporary onEscape.
  if (choice.summarize) host.notice("Summarizing branch…");
  try {
    const images = entryImages(host, entryId);
    const result = await session.navigateTree(entryId, {
      summarize: choice.summarize,
      ...(choice.customInstructions === undefined ? {} : { customInstructions: choice.customInstructions }),
    });
    if (result.aborted) {
      host.notice("Branch summarization cancelled.");
      await runTree(host, entryId);
      return;
    }
    if (result.cancelled) {
      host.notice("Navigation cancelled.");
      return;
    }
    host.resetTranscript();
    if (result.editorText !== undefined && host.getEditorText().trim() === "") {
      host.restoreEditorDraft(result.editorText, labelStoredImages(result.editorText, images));
    }
    host.notice("Navigated to selected point.");
  } catch (error) {
    host.notice(`Navigation failed: ${errorText(error)}`, "error");
  }
}
