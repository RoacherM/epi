// /settings' "Default thinking level per model" item (docs/tui-design.md 4.6, dogfood D29): Pi's
// model-thinking submenu (settings-selector.js) rebuilt from pi-tui parts, because the
// SelectSubmenu/SteppedSubmenu it is made of (settings-submenu.js) aren't exported. Two steps like
// Pi's: pick a model, then its level. Esc on the levels goes back to the models, Esc on the models
// closes the submenu, and picking a level starts over at the models (Pi's `loop: true`).
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getSelectListTheme, type AgentSession, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, SelectList, SelectListLayoutOptions } from "@earendil-works/pi-tui";

import type { CommandHost } from "./command-host.js";
import { piTui } from "./pi-tui.js";

type ThinkingLevel = AgentSession["thinkingLevel"];

/** Pi's DEFAULT_THINKING_LEVEL (core/defaults.js, not exported). */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
/** Pi's SUBMENU_SELECT_LIST_LAYOUT (settings-submenu.js) and MODEL_PICKER_LAYOUT (settings-selector.js). */
const SUBMENU_LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };
const MODEL_PICKER_LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };
/** Pi's THINKING_DESCRIPTIONS (settings-selector.js). */
const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};
const CLEAR_OVERRIDE_VALUE = "__clear__";
const SELECT_KEYS = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;

const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

/** Pi's modelThinkingOverridesSummary: the item's value in the settings list. */
export function modelThinkingSummary(overrides: Record<string, unknown>): string {
  const count = Object.keys(overrides).length;
  return count === 0 ? "none" : `${count} configured`;
}

interface Step {
  title: string;
  description: string;
  options: SelectItem[];
  preselect: string | undefined;
  searchable: boolean;
  layout: SelectListLayoutOptions;
  onSelect(value: string): void;
  onCancel(): void;
}

/** Pi's SelectSubmenu: a title, a description, an optional fuzzy search box, a SelectList and a hint. */
function selectSubmenu(theme: Theme, step: Step): Component {
  const box = new piTui.Container();
  box.addChild(new piTui.Text(theme.bold(theme.fg("accent", step.title)), 0, 0));
  box.addChild(new piTui.Spacer(1));
  box.addChild(new piTui.Text(theme.fg("muted", step.description), 0, 0));
  let search: InstanceType<typeof piTui.Input> | undefined;
  if (step.searchable) {
    box.addChild(new piTui.Spacer(1));
    search = new piTui.Input();
    search.onSubmit = () => list.handleInput("\r");
    box.addChild(search);
  }
  box.addChild(new piTui.Spacer(1));
  const build = (options: SelectItem[], preselect: string | undefined): SelectList => {
    const built = new piTui.SelectList(options, Math.min(options.length, 10), getSelectListTheme(), step.layout);
    const index = options.findIndex((option) => option.value === preselect);
    if (index !== -1) built.setSelectedIndex(index);
    built.onSelect = (item) => step.onSelect(item.value);
    built.onCancel = step.onCancel;
    return built;
  };
  let list = build(step.options, step.preselect);
  const listIndex = box.children.length;
  box.addChild(list);
  box.addChild(new piTui.Spacer(1));
  const hint = step.searchable ? "  Type to filter · Enter to select · Esc to go back" : "  Enter to select · Esc to go back";
  box.addChild(new piTui.Text(theme.fg("dim", hint), 0, 0));
  return {
    render: (width) => box.render(width),
    invalidate: () => box.invalidate(),
    handleInput(data) {
      const keys = piTui.getKeybindings();
      if (search === undefined || SELECT_KEYS.some((id) => keys.matches(data, id))) {
        list.handleInput(data);
        return;
      }
      search.handleInput(data);
      const query = search.getValue();
      const filtered = query === ""
        ? step.options
        : piTui.fuzzyFilter(step.options, query, (item) => `${item.label} ${item.description ?? ""}`);
      list = build(filtered, "");
      box.children[listIndex] = list;
    },
  };
}

/**
 * The submenu for SettingsList's `submenu`. Picking a level saves it and, when it is the current
 * model's, sets the session's level too, as Pi's onModelThinkingLevelChange/Remove callbacks
 * (interactive-mode.js showSettingsSelector) do; the prompt frame reads session.thinkingLevel on
 * every render. Switching models needs nothing here: AgentSession.setModel/cycleModel already pick
 * the saved level (_getThinkingLevelForModelSwitch).
 */
export function modelThinkingSubmenu(host: CommandHost, done: (summary?: string) => void): Component {
  const session = host.session();
  const settings = session.settingsManager;
  const models = session.modelRuntime.getAvailableSnapshot();
  const byKey = new Map(models.map((model) => [modelKey(model), model]));
  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const defaultKey = defaultProvider !== undefined && defaultModelId !== undefined && byKey.has(`${defaultProvider}/${defaultModelId}`)
    ? `${defaultProvider}/${defaultModelId}`
    : undefined;
  const currentKey = session.model === undefined ? undefined : modelKey(session.model);
  const overrides = () => settings.getAllModelThinkingLevels();

  let active: Component;
  const showModels = () => {
    const sorted = [...models].sort((a, b) => {
      const aKey = modelKey(a);
      const bKey = modelKey(b);
      if (aKey === currentKey) return -1;
      if (bKey === currentKey) return 1;
      if (aKey === defaultKey) return -1;
      if (bKey === defaultKey) return 1;
      return a.provider.localeCompare(b.provider);
    });
    const saved = overrides();
    const options: SelectItem[] = sorted.map((model) => {
      const level = saved[modelKey(model)];
      return {
        value: modelKey(model),
        label: `${model.id} ${host.theme.fg("muted", `[${model.provider}]`)}`,
        ...(level === undefined ? {} : { description: level }),
      };
    });
    if (options.length === 0) {
      options.push({ value: "__none__", label: "No models available", description: "Log in to a provider or configure an API key first" });
    }
    active = selectSubmenu(host.theme, {
      title: "Per-Model Thinking Level",
      description: "Step 1/2 · Select a model to configure",
      options,
      preselect: currentKey ?? defaultKey,
      searchable: true,
      layout: MODEL_PICKER_LAYOUT,
      onSelect: (key) => showLevels(key),
      onCancel: () => done(modelThinkingSummary(overrides())),
    });
  };
  const showLevels = (key: string) => {
    const model = byKey.get(key);
    const saved = overrides()[key];
    const levels: ThinkingLevel[] = model === undefined ? [] : model.reasoning ? getSupportedThinkingLevels(model) : ["off"];
    const options: SelectItem[] = levels.map((level) => ({
      value: level,
      label: `${level === saved ? "✓ " : "  "}${level}`,
      description: THINKING_DESCRIPTIONS[level] ?? "",
    }));
    if (model !== undefined && saved !== undefined) {
      const globalDefault = settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
      options.push({ value: CLEAR_OVERRIDE_VALUE, label: "  (clear override)", description: `Revert to global default (${globalDefault})` });
    }
    active = selectSubmenu(host.theme, {
      title: `Thinking Level for ${model === undefined ? key : `${model.id} [${model.provider}]`}`,
      description: "Step 2/2 · Select default thinking level for this model",
      options,
      preselect: saved,
      searchable: false,
      layout: SUBMENU_LAYOUT,
      onSelect: (value) => {
        if (model !== undefined) save(model, value);
        showModels();
      },
      onCancel: showModels,
    });
  };
  const save = (model: Model<Api>, value: string) => {
    const isCurrent = session.model !== undefined && modelKey(session.model) === modelKey(model);
    if (value === CLEAR_OVERRIDE_VALUE) {
      settings.removeModelThinkingLevel(model.provider, model.id);
      if (isCurrent) session.setThinkingLevel(settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
    } else {
      settings.setModelThinkingLevel(model.provider, model.id, value as ThinkingLevel);
      if (isCurrent) session.setThinkingLevel(value as ThinkingLevel);
    }
    host.tui.requestRender();
  };
  showModels();
  return {
    render: (width) => active.render(width),
    handleInput: (data) => active.handleInput?.(data),
    invalidate: () => active.invalidate(),
  };
}
