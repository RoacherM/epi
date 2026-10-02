// A Manifest (external) extension that adds a system-prompt section in before_agent_start, like Pi's
// MCP extension does for `mcp_servers`: MMP's forced prompt must still contain it.
export default function (pi) {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.mmp_test_external = "external section text";
  });
}
