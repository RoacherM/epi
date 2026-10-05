// `node --import` hook for the D6 test (test/mcp.test.mjs): Pi's extensions/mcp/runtime.js loads
// as usual, except that constructing an McpServerConnection throws -- so the failure lands inside
// Pi's own startup chain (createConnection), after Epi's epi:mcp factory has already loaded the
// same file for its transport. Test only: matches Pi's file by path, so if Pi moves runtime.js the
// hook stops applying and the test fails on the missing error line.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!/\/pi-coding-agent\/dist\/extensions\/mcp\/runtime\.js$/.test(result.url)) return result;
    const source =
      `export * from ${JSON.stringify(`${result.url}?real`)};\n` +
      `export class McpServerConnection { constructor() { throw new Error("simulated: McpServerConnection is unavailable"); } }\n`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
