import type { CommandHost } from "./command-host.js";
export interface KeyAction {
    /** Pi keybinding id, e.g. "app.model.select". */
    id: string;
    when?: (host: CommandHost) => boolean;
    run: (host: CommandHost) => void | Promise<void>;
}
export declare function createKeyActions(): KeyAction[];
//# sourceMappingURL=keys.d.ts.map