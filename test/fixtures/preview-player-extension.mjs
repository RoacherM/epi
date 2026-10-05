// Asks /preview for its video player over pi.events (docs/preview-design.md §5.2), the way another
// extension would, and reports what it got through ctx.ui.notify and, when EPI_PLAYER_PROBE_OUT is
// set (-p has no UI), as JSON lines in that file. Used by test/preview.test.mjs.
//   at load:       asks once in the factory, before the built-in extensions are loaded
//   /askplayer:    asks now; says whether it got createPane, and whether the API is not the one
//                  the previous load got (a /reload must be answered by the new preview)
//   /holdpane <f>: creates a pane for <f>, draws it once (which starts playing) and keeps it
//   /panestate:    draws the kept pane again and says whether it shows "stopped"
//   /stalepane <f>: calls createPane for <f> on the API the last /askplayer got, without asking again,
//                  and reports the rejection (or that it got a pane)
import { appendFileSync } from "node:fs";

const CHANNEL = "epi/preview/player/v1";
let previousApi;
let held;

function report(ctx, text) {
  ctx?.ui.notify(text, "info");
  if (process.env.EPI_PLAYER_PROBE_OUT) appendFileSync(process.env.EPI_PLAYER_PROBE_OUT, `${JSON.stringify(text)}\n`);
}

function ask(pi) {
  const request = {};
  pi.events.emit(CHANNEL, request);
  return request.player;
}

export default function (pi) {
  const atLoad = ask(pi);
  report(undefined, `PLAYER-AT-LOAD:${atLoad === undefined ? "none" : "answered"}`);

  pi.registerCommand("askplayer", {
    description: "asks /preview for the video player",
    handler: async (_args, ctx) => {
      const api = ask(pi);
      const fresh = previousApi === undefined ? "first" : api === previousApi ? "same" : "new";
      if (api !== undefined) previousApi = api;
      report(ctx, `PLAYER:${typeof api?.createPane === "function" ? "createPane" : "none"}:${fresh}`);
    },
  });

  pi.registerCommand("holdpane", {
    description: "creates a player pane and keeps it",
    handler: async (args, ctx) => {
      const api = ask(pi);
      await ctx.ui.custom(async (tui, theme, _keybindings, done) => {
        held = await api.createPane({ video: args.trim(), duration: 10 }, { tui, theme, hint: "q back" });
        held.render(80, 20);
        done(undefined);
        return { render: () => [], invalidate() {} };
      });
      report(ctx, "PANE-HELD");
    },
  });

  pi.registerCommand("stalepane", {
    description: "creates a pane with the API kept from an earlier /askplayer",
    handler: async (args, ctx) => {
      let outcome;
      await ctx.ui.custom(async (tui, theme, _keybindings, done) => {
        try {
          const pane = await previousApi.createPane({ video: args.trim(), duration: 10 }, { tui, theme });
          pane.dispose();
          outcome = "created";
        } catch (error) {
          outcome = `rejected: ${error.message}`;
        }
        done(undefined);
        return { render: () => [], invalidate() {} };
      });
      report(ctx, `STALE-PANE:${outcome}`);
    },
  });

  pi.registerCommand("panestate", {
    description: "draws the kept pane again",
    handler: async (_args, ctx) => {
      const { body } = held.render(80, 20);
      report(ctx, `PANE-STATE:${body.join("\n").includes("stopped") ? "stopped" : "playing"}`);
    },
  });
}
