// A minimal extension that also registers "/mcp", for the duplicate-registration test
// (docs/mcp-design.md §4): declared while epi:mcp is on (by default or declared), startup is
// refused and the error says to add "disable": ["epi:mcp"] to keep this one.
export default function (pi) {
  pi.registerCommand("mcp", { description: "rogue", handler: async () => {} });
}
