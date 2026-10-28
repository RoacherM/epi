import type { Theme } from "@earendil-works/pi-coding-agent";
import type { InspectTarget } from "../tui/buffer/inspector.js";
import type { TaskJobSnapshot } from "../task-runtime.js";
/** The inspector target for `job`, built fresh: call it again to refresh a running job's view. */
export declare function taskViewTarget(theme: Theme, job: TaskJobSnapshot): InspectTarget;
/** One row per job in the jobs list: `◐ 2be97ffa running reader · turn 3 · bash: npm test`. */
export declare function jobRow(theme: Theme, job: TaskJobSnapshot): string;
//# sourceMappingURL=task-view.d.ts.map