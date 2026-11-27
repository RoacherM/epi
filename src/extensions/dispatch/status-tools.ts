// `task_status` / `task_wait` / `task_cancel` / `task_input`: one set of tools over every dispatch
// item, routed by prefix (`bg_*`, `job_*` or a task name, `tm_*`). Reading a settled item's report
// is a delivery: its pending notification is withdrawn and counted as acknowledged.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { BgProcessRuntime } from "./bg-bash.js";
import type { NotificationLedger, PollGuard } from "./notify-ledger.js";
import type { DispatchRegistry } from "./registry.js";
import { foregroundBudgetMs } from "./task-tool.js";
import type { DispatchItemReport, DispatchItemSummary } from "./types.js";

export interface StatusToolDeps {
  registry: DispatchRegistry;
  ledger: NotificationLedger;
  pollGuard: PollGuard;
  bg: BgProcessRuntime;
  /** Foreground waits that `/bg` or `Alt+B` may detach early. */
  foregroundWaits?: Set<() => void>;
  /** Default TUI foreground wait budget in seconds (0 disables). */
  foregroundBudgetSeconds?: number | undefined;
  unknownRefHint?: ((ref: string) => string | undefined) | undefined;
  /** Worker slices see only their own items; the description says so. */
  scope: "all" | "own";
}

function text(value: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: value }], details: details ?? {} };
}

function listLine(item: DispatchItemSummary): string {
  return `${item.id}${item.name === undefined ? "" : ` [${item.name}]`} ${item.status}: ${item.label}`;
}

/** A settled item's report was read: its notification has been delivered. */
function collectIfSettled(ledger: NotificationLedger, report: DispatchItemReport): void {
  if (report.summary.active) return;
  ledger.collect(report.summary.id);
  ledger.collect(`${report.summary.id}:`, true);
}

const StatusParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "bg_*, job_*, task name, or tm_*; omit to list all" })),
});

const WaitParameters = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1 }),
  mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
});

const CancelParameters = Type.Object({
  id: Type.String(),
  forceDirty: Type.Optional(Type.Boolean({ description: "Delete dirty isolated workspace" })),
});

const InputParameters = Type.Object({
  id: Type.String(),
  input: Type.Optional(Type.String()),
  end: Type.Optional(Type.Boolean({ description: "Close stdin" })),
});

function resolveWithHint(deps: StatusToolDeps, ref: string) {
  try {
    return deps.registry.resolve(ref);
  } catch (error) {
    const hint = deps.unknownRefHint?.(ref);
    if (hint === undefined) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${hint}`, { cause: error });
  }
}

function statusTool(deps: StatusToolDeps): ToolDefinition<typeof StatusParameters> {
  return {
    name: "task_status",
    label: "Task Status",
    description: `Inspect one item or list ${deps.scope === "own" ? "own " : ""}background items (do not poll).`,
    parameters: StatusParameters,
    async execute(_id, params: Static<typeof StatusParameters>) {
      if (params.id === undefined) {
        const items = deps.registry.list();
        return text(items.length === 0 ? "No background items." : items.map(listLine).join("\n"), { items });
      }
      const { provider, id } = resolveWithHint(deps, params.id);
      const report = provider.report(id);
      const hint = report.summary.active ? deps.pollGuard.check(id, `${report.summary.status}\0${report.text}`) : undefined;
      if (hint !== undefined) return text(`${id} ${report.summary.status}. ${hint}`, { unchanged: true });
      collectIfSettled(deps.ledger, report);
      return text(report.text, report.details);
    },
  };
}

type WaitEnd = "settled" | "timeout" | "budget" | "detached" | "aborted";

function waitLimit(timeoutSeconds: number | undefined, budgetMs: number | undefined): { ms: number; end: "timeout" | "budget" } | undefined {
  const askedMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000;
  if (budgetMs === undefined) return askedMs === undefined ? undefined : { ms: askedMs, end: "timeout" };
  return askedMs !== undefined && askedMs < budgetMs ? { ms: askedMs, end: "timeout" } : { ms: budgetMs, end: "budget" };
}

function waitNote(end: WaitEnd, reports: readonly DispatchItemReport[]): string {
  if (!reports.some((report) => report.summary.active)) return "";
  switch (end) {
    case "detached":
      return "\n\nStopped waiting (/bg); active items keep running in the background and will notify you when settled.";
    case "budget":
      return "\n\nForeground wait budget reached; active items keep running and will notify you when settled. End your turn or do other work instead of waiting again.";
    case "timeout":
      return "\n\nWait timeout reached; active items keep running and will notify you when settled.";
    default:
      return "";
  }
}

function waitTool(deps: StatusToolDeps): ToolDefinition<typeof WaitParameters> {
  return {
    name: "task_wait",
    label: "Task Wait",
    description: "Wait for bg_*/job_* items to settle (all or any); timeoutSeconds/Esc stops waiting without cancelling.",
    parameters: WaitParameters,
    async execute(_id, params: Static<typeof WaitParameters>, signal, _onUpdate, ctx) {
      const targets = params.ids.map((ref) => deps.registry.resolve(ref));
      const tm = targets.find((target) => target.provider.kind === "tm");
      if (tm !== undefined) throw new Error(`${tm.id} is a timer; it notifies you when it fires`);
      let end: WaitEnd = "settled";
      const controller = new AbortController();
      const onAbort = (): void => { end = "aborted"; controller.abort(); };
      const detach = (): void => { end = "detached"; controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      deps.foregroundWaits?.add(detach);
      const limit = waitLimit(params.timeoutSeconds, foregroundBudgetMs(ctx?.mode, deps.foregroundBudgetSeconds));
      const timer = limit === undefined ? undefined : setTimeout(() => { end = limit.end; controller.abort(); }, limit.ms);
      try {
        const waits = targets.map((target) => target.provider.wait(target.id, controller.signal));
        await ((params.mode ?? "all") === "any" ? Promise.race(waits) : Promise.all(waits));
      } finally {
        clearTimeout(timer);
        deps.foregroundWaits?.delete(detach);
        signal?.removeEventListener("abort", onAbort);
      }
      const reports = targets.map((target) => target.provider.report(target.id));
      for (const report of reports) collectIfSettled(deps.ledger, report);
      return text(`${reports.map((report) => report.text).join("\n\n")}${waitNote(end, reports)}`, { items: reports.map((report) => report.details), waitEnd: end });
    },
  };
}

function cancelTool(deps: StatusToolDeps): ToolDefinition<typeof CancelParameters> {
  return {
    name: "task_cancel",
    label: "Task Cancel",
    description: "Stop a bg_*, job_*/named task, or tm_* timer (keeps dirty workspace unless forceDirty).",
    parameters: CancelParameters,
    async execute(_id, params: Static<typeof CancelParameters>) {
      const { provider, id } = resolveWithHint(deps, params.id);
      const report = await provider.cancel(id, { forceDirty: params.forceDirty === true });
      deps.ledger.discard(id);
      deps.ledger.discard(`${id}:`, true);
      const workspace = (report.details?.job as { workspace?: { removed?: boolean; diffStat?: string; path?: string } } | undefined)?.workspace;
      const kept = workspace !== undefined && workspace.removed !== true && workspace.diffStat !== undefined
        ? `\nWorkspace kept at ${workspace.path} because it holds work (${workspace.diffStat}); task_cancel({ id: "${id}", forceDirty: true }) deletes it.`
        : "";
      return text(`${report.text}${kept}`, report.details);
    },
  };
}

function inputTool(deps: StatusToolDeps): ToolDefinition<typeof InputParameters> {
  return {
    name: "task_input",
    label: "Task Input",
    description: "Write to stdin of a running bg_* command.",
    parameters: InputParameters,
    async execute(_id, params: Static<typeof InputParameters>) {
      const { provider, id } = deps.registry.resolve(params.id);
      if (provider.kind !== "bg") throw new Error(`${id} is not a bash job; steer tasks with task({ jobId, task })`);
      return text(deps.bg.input(id, params.input, params.end === true));
    },
  };
}

export function createStatusTools(deps: StatusToolDeps): ToolDefinition[] {
  return [statusTool(deps), waitTool(deps), cancelTool(deps), inputTool(deps)] as unknown as ToolDefinition[];
}
