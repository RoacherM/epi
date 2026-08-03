import { tsImport } from "tsx/esm/api";
let adapterModulePromise;
function loadAdapterModule() {
    adapterModulePromise ??= tsImport("pi-mcp-adapter", import.meta.url);
    return adapterModulePromise;
}
export function createMmpMcpExtension(options) {
    return {
        name: "mmp:mcp",
        factory: async (pi) => {
            const { createMcpAdapter } = await loadAdapterModule();
            await createMcpAdapter(options)(pi);
        },
    };
}
//# sourceMappingURL=mcp.js.map