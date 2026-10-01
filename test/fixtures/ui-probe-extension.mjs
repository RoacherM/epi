// Exercises the extension UI host: custom() with pi-tui keybindings (like the MCP panel) and select().
export default function (pi) {
  pi.registerCommand("instant", {
    description: "custom() that finishes before it is mounted",
    handler: async (_args, ctx) => {
      const result = await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
        done("INSTANT-DONE");
        return { render: () => ["INSTANT-PANEL-SHOULD-NOT-STAY"], invalidate() {} };
      });
      ctx.ui.notify(`instant result: ${result}`, "info");
    },
  });
  pi.registerCommand("say", {
    description: "displayed custom message probe",
    handler: async () => {
      pi.sendMessage({ customType: "s2-probe", content: "S2-PROBE-MESSAGE", display: true });
    },
  });
  pi.registerCommand("pick", {
    description: "custom() probe",
    handler: async (_args, ctx) => {
      const result = await ctx.ui.custom((_tui, theme, keybindings, done) => ({
        render: () => [theme.fg("accent", "CUSTOM-PANEL-OPEN press enter")],
        invalidate() {},
        handleInput(data) {
          if (keybindings.matches(data, "tui.select.confirm")) done("PICKED-VIA-CUSTOM");
        },
      }));
      ctx.ui.notify(`custom result: ${result}`, "info");
    },
  });
  pi.registerCommand("choose", {
    description: "select() probe",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("CHOOSE-ONE", ["alpha", "beta"]);
      ctx.ui.notify(`select result: ${choice}`, "info");
    },
  });
}
