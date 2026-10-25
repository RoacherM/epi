// THROWAWAY: tests Pi's extension seam, NOT a LayerFS implementation.
// The backend is deliberately injected; this file imports no Epi implementation.
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';

export const ENTRY = 'layerfs-probe/checkpoint-v1';

export function workspaceExtension(backend) {
  return (pi) => {
    let closed = false;
    let tail = Promise.resolve();
    // Serialize the whole tool + checkpoint, not just individual file writes.
    const exclusive = (work) => {
      const result = tail.then(() => {
        if (closed) throw new Error('probe workspace is closed');
        return work();
      });
      tail = result.catch(() => {});
      return result;
    };
    const checkpoint = async (source, toolCallId) => {
      const saved = await backend.checkpoint();
      if (saved) pi.appendEntry(ENTRY, { ...saved, source, toolCallId });
    };

    pi.registerCommand('layerfs-probe', {
      description: 'Offline workspace extension probe (not real LayerFS)',
      handler: async (_args, ctx) => ctx.ui.notify('FAKE workspace backend', 'info'),
    });
    const tools = [
      createReadToolDefinition(backend.cwd, { operations: backend.read }),
      createWriteToolDefinition(backend.cwd, { operations: backend.write }),
      createEditToolDefinition(backend.cwd, {
        operations: { ...backend.read, writeFile: backend.write.writeFile },
      }),
      createBashToolDefinition(backend.cwd, {
        operations: backend.bash,
        exposeSessionEnvironment: false,
      }),
    ];
    for (const tool of tools) {
      pi.registerTool({
        ...tool,
        execute: (id, params, signal, onUpdate, ctx) => exclusive(async () => {
          signal?.throwIfAborted();
          const result = await tool.execute(id, params, signal, onUpdate, ctx);
          if (tool.name !== 'read') await checkpoint(tool.name, id);
          return result;
        }),
      });
    }
    pi.on('user_bash', () => ({
      operations: {
        exec: (command, cwd, options) => exclusive(async () => {
          options.signal?.throwIfAborted();
          const result = await backend.bash.exec(command, cwd, options);
          await checkpoint('user_bash', undefined);
          return result;
        }),
      },
    }));
    pi.on('session_shutdown', async () => {
      if (closed) return;
      closed = true;
      await tail;
      await backend.close();
    });
  };
}
