// `task_status` / `task_wait` / `task_cancel` / `task_input`: one set of tools over every dispatch
// item, routed by prefix (`bg_*`, `job_*` or a task name, `tm_*`). Reading a settled item's report
// is a delivery: its pending notification is withdrawn and counted as acknowledged.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { BgProcessRuntime } from "./bg-bash.js";
import type { NotificationLedger, PollGuard } from "./notify-ledger.js";
import type { DispatchRegistry } from "./registry.js";
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
  id: Type.Optional(Type.String({ description: "bg_<id>, job_<id>, a task name, or tm_<id>; omit to list everything" })),
});

const WaitParameters = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1, description: "bg_* / job_* / task names to wait for" }),
  mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Stop waiting after this long (the items keep running)" })),
});

const CancelParameters = Type.Object({
  id: Type.String({ description: "bg_<id>, job_<id>, a task name, or tm_<id>" }),
  forceDirty: Type.Optional(Type.Boolean({ description: "Also delete an isolated workspace that still holds uncommitted or unmerged work" })),
});

const InputParameters = Type.Object({
  id: Type.String({ description: "bg_<id> started with stdin: true or isDaemon: true" }),
  input: Type.Optional(Type.String()),
  end: Type.Optional(Type.Boolean({ description: "Close stdin after writing" })),
});

function statusTool(deps: StatusToolDeps): ToolDefinition<typeof StatusParameters> {
  return {
    name: "task_status",
    label: "Task Status",
    description: `Show one dispatch item (output so far, result, workspace) or list all ${deps.scope === "own" ? "of your own " : ""}background items. Do not poll: settled items notify you.`,
    parameters: StatusParameters,
    async execute(_id, params: Static<typeof StatusParameters>) {
      if (params.id === undefined) {
        const items = deps.registry.list();
        return text(items.length === 0 ? "No background items." : items.map(listLine).join("\n"), { items });
      }
      const { provider, id } = deps.registry.resolve(params.id);
      const report = provider.report(id);
      const hint = report.summary.active ? deps.pollGuard.check(id, `${report.summary.status}\0${report.text}`) : undefined;
      if (hint !== undefined) return text(`${id} ${report.summary.status}. ${hint}`, { unchanged: true });
      collectIfSettled(deps.ledger, report);
      return text(report.text, report.details);
    },
  };
}

function effectiveWaitMs(timeoutSeconds: number | undefined, mode: string | undefined, budgetSec: number | undefined): number | undefined {
  const defaultSec = mode === "tui" ? (budgetSec ?? 300) : 0;
  const sec = timeoutSeconds ?? (defaultSec > 0 ? defaultSec : undefined);
  return sec === undefined ? undefined : sec * 1_000;
}

function waitTool(deps: StatusToolDeps): ToolDefinition<typeof WaitParameters> {
  return {
    name: "task_wait",
    label: "Task Wait",
    description: "Block until the given bg_* / job_* items settle (mode all, default) or the first one does (any). Waiting never stops them; Esc or timeoutSeconds just stops waiting.",
    parameters: WaitParameters,
    async execute(_id, params: Static<typeof WaitParameters>, signal, _onUpdate, ctx) {
      const targets = params.ids.map((ref) => deps.registry.resolve(ref));
      const tm = targets.find((target) => target.provider.kind === "tm");
      if (tm !== undefined) throw new Error(`${tm.id} is a timer; it notifies you when it fires`);
      let detached = false;
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      const detach = (): void => { detached = true; controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      deps.foregroundWaits?.add(detach);
      const waitMs = effectiveWaitMs(params.timeoutSeconds, ctx?.mode, deps.foregroundBudgetSeconds);
      const timer = waitMs === undefined ? undefined : setTimeout(onAbort, waitMs);
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
      const note = detached && reports.some((r) => r.summary.active) ? "\n\nStopped waiting (/bg); active items keep running in the background and will notify you when settled." : "";
      return text(`${reports.map((report) => report.text).join("\n\n")}${note}`, { items: reports.map((report) => report.details) });
    },
  };
}

function cancelTool(deps: StatusToolDeps): ToolDefinition<typeof CancelParameters> {
  return {
    name: "task_cancel",
    label: "Task Cancel",
    description: "Stop a bg_* command, a job_* / named task, or cancel a tm_* timer. An isolated workspace with unmerged changes is kept unless forceDirty: true.",
    parameters: CancelParameters,
    async execute(_id, params: Static<typeof CancelParameters>) {
      const { provider, id } = deps.registry.resolve(params.id);
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
    description: "Write to the stdin of a running bg_* command (started with stdin: true or isDaemon: true); end: true closes it.",
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
