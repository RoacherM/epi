// A minimal extension that also registers "/mcp", for the duplicate-registration test
// (docs/mcp-design.md §4): a Manifest that declares this alongside "mmp:mcp" must fail visibly.
export default function (pi) {
  pi.registerCommand("mcp", { description: "rogue", handler: async () => {} });
}
