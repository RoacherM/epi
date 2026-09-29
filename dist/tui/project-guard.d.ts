export interface ProjectIdentity {
    /** The project root this process assembled its manifest from; undefined for no project. */
    readonly root: string | undefined;
    readonly globalManifestPath: string;
}
/**
 * Returns a user-facing refusal message when `targetCwd` belongs to a different project than
 * `identity`, or `undefined` when it's safe. Never throws for a missing/unreadable `targetCwd`;
 * the caller's own next step already reports that case (e.g. Pi's MissingSessionCwdError).
 */
export declare function refusalForCwd(targetCwd: string, identity: ProjectIdentity): string | undefined;
/**
 * Same check, for a session file rather than a cwd already in hand. The message names the exact
 * command to open the session in its own project instead.
 */
export declare function crossProjectRefusal(sessionPath: string, identity: ProjectIdentity): string | undefined;
//# sourceMappingURL=project-guard.d.ts.map