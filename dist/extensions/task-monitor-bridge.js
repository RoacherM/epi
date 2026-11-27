export function createTaskMonitorBridge() {
    let taskProvider;
    let monitorProvider;
    const listeners = new Set();
    return {
        registerTaskProvider(provider) {
            taskProvider = provider;
        },
        registerMonitorProvider(provider) {
            monitorProvider = provider;
        },
        hasTaskProvider() {
            return taskProvider !== undefined;
        },
        hasTaskJob(idOrPrefix) {
            return taskProvider?.hasJob(idOrPrefix) === true;
        },
        listMonitors() {
            return monitorProvider?.list() ?? [];
        },
        getMonitor(id) {
            return monitorProvider?.get(id);
        },
        settleSources() {
            return monitorProvider?.settle === undefined ? [] : [monitorProvider.settle];
        },
        onMonitorChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        notifyMonitorChanged() {
            for (const fn of [...listeners])
                fn();
        },
    };
}
//# sourceMappingURL=task-monitor-bridge.js.map