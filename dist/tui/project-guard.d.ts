export interface ProjectIdentity {
    /** The project root this process assembled its manifest from; undefined for no project. */
    readonly root: string | undefined;
    readonly globalManifestPath: string;
    /** The home the run was prepared with (assembly.ts's `homeDir`, D68). */
    readonly homeDir: string;
}
/**
 * Same check, for a session file rather than a cwd already in hand. The message names the exact
 * command to open the session in its own project instead.
 */
export declare function crossProjectRefusal(sessionPath: string, identity: ProjectIdentity): string | undefined;
//# sourceMappingURL=project-guard.d.ts.map