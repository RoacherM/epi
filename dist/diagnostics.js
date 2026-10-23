/** Extension load failures and package warnings, in Pi's order: errors, then warnings. */
export function extensionLoadDiagnostics(resourceLoader) {
    const extensions = resourceLoader.getExtensions();
    return [
        ...extensions.errors.map(({ path, error }) => ({
            type: "error",
            message: `Failed to load extension "${path}": ${error}`,
        })),
        ...(extensions.warnings ?? []).map(({ path, warning }) => ({
            type: "warning",
            message: `Extension package "${path}": ${warning}`,
        })),
    ];
}
//# sourceMappingURL=diagnostics.js.map