export interface ProjectIdentity {
    /** The project root this process assembled its manifest from; undefined for no project. */
    readonly root: string | undefined;
    readonly globalManifestPath: string;
}
/**
 * Returns a user-facing refusal message when `targetCwd` belongs to a different project than
 * `identity`, or `undefined` when it's safe. A `targetCwd` that no longer exists is left to the
 * caller's next step, which reports it (Pi's MissingSessionCwdError); any other error propagates.
 */
export declare function refusalForCwd(targetCwd: string, identity: ProjectIdentity): string | undefined;
/**
 * Same check, for a session file rather than a cwd already in hand. The message names the exact
 * command to open the session in its own project instead.
 */
export declare function crossProjectRefusal(sessionPath: string, identity: ProjectIdentity): string | undefined;
//# sourceMappingURL=project-guard.d.ts.map