# OMP (oh-my-pi) study, for MMP positioning

Date: 2026-10-02. Read-only study of OMP source.

**Sources and how to read the citations**

- OMP: https://github.com/can1357/oh-my-pi, shallow clone at commit `2a7db74`, version 18.4.9 (root `package.json` catalog). OMP paths are relative to that repo root. `CA/` = `packages/coding-agent/src/`.
- Pi: `node_modules/@earendil-works/pi-coding-agent@1.0.0/docs/*.md` inside MMP (the version MMP's `pi-100-upgrade` branch pins).
- MMP: paths relative to this repo. Note: the product/architecture doc is **`docs/development.md`** (there is no root `DEVELOPMENT.md`; the current `AGENTS.md:5` links `docs/development.md` correctly).
- Provenance tags: no tag = I read it myself; **[sub]** = reported by a research subagent with a citation I did not re-open; **(inferred)** = my inference, not stated in source. The setting defaults in §3 that drive §7 (`tools.approvalMode`, `memory.backend`, `task.isolation.enabled`, `tools.xdev`, `dev.autoqa`, `advisor.enabled`, `ttsr.enabled`, `telemetry.otlpExportEnabled`, `collab.autoStart`, `compaction.enabled`) I re-checked in source.

---

## 1. What OMP is

| Question | Answer | Source |
|---|---|---|
| Relationship to Pi | **Hard fork** of pi-mono, not a layer. All packages renamed `@mariozechner/*` / `@earendil-works/*` → `@oh-my-pi/*`. | `README.md:22`, `README.md:567`; `docs/porting-from-pi-mono.md:44-55` |
| How it tracks upstream | Manual: `git format-patch <marker>..HEAD` from pi-mono, port by hand, record a new marker. Last marker **2026-03-22** (`b21b42d`). §15 lists "intentional divergences — do not port" (StatusLine vs FooterDataProvider, sqlite auth store, capability discovery, tool factory shape…). | `docs/porting-from-pi-mono.md:6-17`, `:301-395` |
| Upstream lag | Marker is ~6 months old while Pi is at 1.0.0 → OMP is effectively diverged, not following Pi (inferred from marker; may be stale). | same |
| Pi extension compat | Kept on purpose: `legacy-pi-compat.ts` rewrites `@mariozechner/*`, `@earendil-works/*`, `@sinclair/typebox` imports; `pkg.omp` manifest preferred, `pkg.pi` fallback. CHANGELOG keeps fixing upstream-Pi extensions (e.g. Pi 0.84.2 compaction APIs). | `docs/porting-from-pi-mono.md:147`, `:371`; `packages/coding-agent/CHANGELOG.md:965`, `:992` |
| Runtime | **Bun only** (`engines.bun >=1.3.14`); AGENTS.md mandates Bun APIs over Node. Node SDK users still need Bun (inferred from `exports` pointing at `.ts` sources). | `packages/coding-agent/package.json:572-574`, `:44-50`; `AGENTS.md` "Bun Over Node" |
| Natives | One N-API addon (`pi-natives`) aggregating Rust crates: pi-shell (embedded bash = vendored brush + ~60 in-process coreutils), pi-walker, pi-iso, pi-ast, pi-edit, pi-voice, … ~80k LoC "core" Rust (README); `find crates -name '*.rs'` (excl. vendor) = 285k lines incl. tests/ported utils. 6 platform binaries. | `README.md:450-494`, `:657-669` |
| Packaging | npm `@oh-my-pi/pi-coding-agent` (bin `omp` → `src/cli.ts`), curl installer, Homebrew, Nix flake + Home-Manager module, Windows PowerShell, mise. | `README.md:35-94`; `packages/coding-agent/package.json:25-27` |
| Scale | TS lines in `src/`: coding-agent 462k, tui 165k, ai 126k (counted with `wc -l`). | own count |
| CLI surface | `omp [command] [flags] [messages...]`; ~50 subcommands (launch, acp, agents, auth-broker, bench, collab, commit, config, git, join, models, plugin, setup, share, skill, stats, update, worktree, …); shell completions generated from live flag metadata. Only `omp` help is exposed; no `pi` alias (inferred: no `pi` in `bin`). | `docs/cli-reference.md:1-31`, `:235-296`; `README.md:96-109` |
| Entry points | Interactive TUI, `-p` print, `--mode json`, `--mode rpc` / `rpc-ui` (own NDJSON, not JSON-RPC 2.0), `omp acp` (Zed ACP), in-process SDK `createAgentSession`. | `README.md:496-561`; `docs/cli-reference.md:223-231` |

## 2. Architecture map

| Package | npm name | Owns | Internal deps |
|---|---|---|---|
| `ai` | pi-ai | Multi-provider streaming client, auth storage (sqlite `agent.db`, multi-credential, broker) | omptype, catalog, natives, utils, wire |
| `catalog` | pi-catalog | Bundled `models.json`, provider descriptors (KDL rules), model identity | omptype, utils |
| `agent` | pi-agent-core | Agent loop, tool calling, state | ai, catalog, natives, utils, wire, snapcompact |
| `coding-agent` | pi-coding-agent | The CLI/SDK: sessions, tools, task/subagents, MCP, extensions, memory, modes | everything below |
| `tui` | pi-tui | Renderer **plus** the whole chat UI (chat/, overlays/, status-line/, tool renderers) | omptype, agent, ai, catalog, natives, utils, wire, snapcompact |
| `natives` | pi-natives | N-API bindings to the Rust crates | — |
| `utils` | pi-utils | dirs/env/.env loading, logger, streams, procs | natives |
| `omptype` | omptype | ArkType-compatible schema validation (replaces TypeBox natively) | — |
| `wire` | pi-wire | Collab live-session protocol types, relay constants | — |
| `collab-web` | collab-web | Browser guest client + local relay for `/collab` | utils, wire |
| `mnemopi` | pi-mnemopi | Local SQLite memory engine (also standalone bin) | ai, catalog, natives, utils |
| `snapcompact` | snapcompact | Bitmap-frame context compression | ai, catalog, natives, utils, wire |
| `stats` | omp-stats | Local usage dashboard over session JSONL | ai, catalog, utils |
| `browser-relay` | browser-relay | Chrome extension letting eval's browser drive your own tabs | — |
| `metaharness` | pi-metaharness (private) | **Dev-only** benchmark manager (Harbor, TS-edit, snapcompact), REST/SSE dashboard; not a runtime dependency | coding-agent, … |
| `typescript-edit-benchmark` | (private) | Edit-format benchmark fixtures | coding-agent, … |

Deps from each `package.json` (own script). Note `tui` depends on `agent`/`ai` — unlike upstream pi-tui, it is no longer a generic terminal library (inferred). Boot flow: `packages/coding-agent/DEVELOPMENT.md:29-50`.

```text
            omp (src/cli.ts) ── worker-host dispatch, subcommands
                   │
              main.ts ── settings, model registry
                   │
        createAgentSession (sdk.ts) ──► AgentSession
          │            │             │
   InteractiveMode  print-mode   rpc / acp
   (pi-tui chat UI)
          │
   pi-agent-core ──► pi-ai ──► providers      pi-catalog (models)
          │
   tools / task / mcp / memory / extensions (coding-agent)
          │
   pi-natives (Rust: shell, grep, walker, iso, ast, edit, text width)
```

## 3. Harness capabilities

"Default" = state with no user config.

| Capability | Where | How it works | Default |
|---|---|---|---|
| Subagents (`task`) | `CA/task/*`; `crates/pi-iso` | Agents from `.omp/agents` (project, user), extensions, Claude marketplace plugins, bundled (`scout`, `reviewer`, `security-reviewer`, `task`, `sonic`). Optional typed result via `outputSchema` (validated by `yield`). Results addressable as `agent://<id>/<json.path>`. Optional copy-on-write workspace isolation (APFS clone / overlayfs / ProjFS / worktree) merged back as patch or branch. [sub] `docs/task-agent-discovery.md:128-162`, `docs/tools/task.md:47-58` | **On**; recursion depth 2, concurrency 32 [sub]; isolation **off** (`CA/task/settings.ts:24`) |
| Peer messaging / Agent Hub | `CA/irc/*`; `docs/agent-hub.md` | In-process mailbox; `wait` tool blocks on job/peer message; Alt+A hub to watch, steer, revive, kill subagents. [sub] | On when task is on [sub] |
| Built-in tools | `CA/tools/builtin-names.ts`, `index.ts:740-802` [sub] | On: read (files, dirs, archives, PDFs, URLs, `pr://`…), write, edit (hashline anchors), ast_edit, glob, grep, find, bash (embedded shell), eval (persistent Python + JS, can call tools), lsp, debug (DAP), ask, todo, web_search, task, wait. Off: ast_grep, github, checkpoint/rewind, security_scan, generate_image, tts, memory tools, learn. `README.md:259-311` | 31 tools total (`README.md:27`) |
| `xd://` tool devices | `CA/tools/xdev.ts` | Rarely used tools are removed from the tool list; model discovers them with `read xd://` and runs them with `write xd://<tool>` (shrinks prompt). | **On** (`CA/tools/settings.ts:900`) |
| Internal URL schemes | `CA/internal-urls/router.ts:106-125` [sub] | skill, rule, memory, agent, artifact, proc, cfg, ssh, issue, pr, mcp, conflict, xd… resolved inside every FS-shaped tool. | On |
| Memory | `CA/memory-backend/`, `packages/mnemopi`, `docs/memory.md` | `memory.backend`: off / local (consolidates past sessions into MEMORY.md) / mnemopi (local SQLite, auto-recall first turn) / hindsight (remote) / sharpshooter. Tools retain/recall/reflect/memory_edit appear per backend. | **Off** (`CA/memory-backend/settings.ts:13-17`) |
| Compaction | `CA/session/compaction-methods.ts:44` [sub]; `docs/compaction.md` | Ordered methods: provider-side remote → **snapcompact** (render old history as PNG text frames for a vision model; no LLM call) → handoff doc → shake (swap heavy content for `artifact://` refs) → soft LLM summary. Mid-turn and async compaction. | **On** (`CA/session/context-settings.ts:55`) |
| Advisor / watchdog | `CA/advisor/*`; `docs/advisor-watchdog.md` | Second model (role `advisor`) reads each turn, injects notes/concerns/blockers. | **Off** (`CA/advisor/settings.ts:12-15`) |
| TTSR (stream rules) | `CA/session/ttsr-coordinator.ts`; `docs/ttsr-injection-lifecycle.md` | Regex/ast-grep rules watch the output stream; on match abort, inject rule, retry from same point. Rules from `.omp/rules`, Cursor, Windsurf, Cline, Copilot. | **On** (`CA/export/ttsr-settings.ts:9-11`) |
| Magic keywords, modes | `CA/modes/magic-keywords.ts`; `docs/vibe-mode.md` | `ultrathink`, `orchestrate`, `workflowz` in prose change behaviour; `/plan`, `/vibe` (director + worker sessions), `/goal`, `/loop`. | Keywords on [sub]; modes on demand |
| MCP | `CA/mcp/*`; `docs/mcp-config.md` | Own runtime: stdio/http/sse, OAuth; `.omp/mcp.json` + `~/.omp/agent/mcp.json`; also imports Claude/Codex/Gemini/Cursor/VS Code configs (user-level foreign configs opt-in, project-level foreign configs load). MCP tools default to `write` approval tier. | On; project config on [sub] |
| Extensions / hooks / custom tools | `CA/extensibility/*`; `docs/extensions.md`, `docs/hooks.md` | TS module `factory(pi)`, Pi-compatible via shim; hooks are a legacy alias that load as extensions; `.omp/tools/*` custom tools. **Not sandboxed** (`docs/extension-loading.md:330`). | On |
| Plugins / marketplace | `CA/extensibility/plugins/manager.ts`; `docs/marketplace.md` | Claude-Code-compatible marketplace format (`.claude-plugin/marketplace.json`), `omp plugin install`, lockfile. | On |
| Skills | `docs/skills.md:85-102` [sub] | Discovered from `.omp`, skillshare, plugins, `.claude`, codex, opencode, `.github/skills`; managed (auto-learned) skills in `~/.omp/agent/managed-skills`; `skill://` scheme; `omp skill` registry at skills.omp.sh. | On; autolearn off |
| Profiles | `packages/utils/src/dirs.ts:43-95`; `docs/config-usage.md:76-86` | `--profile` / `OMP_PROFILE` moves every user path to `~/.omp/profiles/<name>/agent`. | default profile |
| Model routing | `CA/config/model-roles.ts:46-80` [sub]; `README.md:332-389` | Roles: default, smol, slow, plan, commit, vision, task, advisor, tiny, memory (+ image, web, speech, judge). `--smol/--slow/--plan`; Ctrl+P cycles role models; `retry.fallbackChains`; path-scoped `enabledModels`; round-robin credentials. | default role only unless configured |
| Permissions | `docs/approval-mode.md:1-30` | Tools declare tier read/write/exec; modes always-ask / write / yolo; per-tool `tools.approval`. **No OS sandbox** [sub]. | **yolo** (`CA/tools/settings.ts:312-315`) |
| Web search / fetch | `CA/web/*`; `README.md:391-448` | `web_search` chains ~23 providers (keyless fallbacks incl. DuckDuckGo); `read <url>` with site-aware extractors (GitHub, registries, arXiv, SO). | **On** [sub] |
| Browser / computer | eval helpers; `packages/browser-relay`; `docs/computer-use.md` | Puppeteer tabs (headless, stealth) or own Chrome via relay; desktop control via native crate. | Browser on, relay off, computer off [sub] |
| LSP / DAP | `CA/lsp/*`, `CA/dap/*` | Auto-starts installed language servers by root marker; diagnostics on write; DAP adapters (lldb, gdb, debugpy, dlv…). | **On** [sub] |
| Collab | `CA/collab/*`, `packages/wire`, `packages/collab-web`; `docs/collab.md` | `/collab` puts session on relay `wss://my.omp.sh`, E2E AES-256-GCM, key in URL fragment; join via `omp join` or browser. | **Off** (`CA/collab/settings.ts:47-50`) |
| Stats | `packages/stats` | Local dashboard (`omp stats`, 127.0.0.1:3847) from session JSONL. `docs/user-facing-packages.md:28-38` | On demand |
| Telemetry / outbound | `CA/telemetry-export.ts`; `docs/install-id.md`; `CA/tools/report-tool-issue.ts` | OTLP export only if `OTEL_*` endpoint set (`docs/environment-variables.md:625-628`). Install-ID UUID sent to some providers/auth gateway [sub]. **Auto-QA** tool-issue reports to `qa.omp.sh`, push gated by first-use consent prompt. | OTLP effectively off; autoqa **on** pending consent (`CA/tools/settings.ts:949-965`) |
| Wire protocol | `packages/wire` | Shared types for collab frames and relay constants (only used by collab). | — |

## 4. Configuration model

| Topic | OMP behaviour | Source |
|---|---|---|
| User root | `~/.omp/agent` (config.yml, mcp.json, models.yml, keybindings.yml, themes/, skills/, sessions, `agent.db`). Root name overridable by `PI_CONFIG_DIR`; agent dir by `PI_CODING_AGENT_DIR` (default profile only). | `docs/config-usage.md:51-74`; `packages/utils/src/dirs.ts:27-28`, `:306-308` |
| Project root | `<cwd>/.omp` (nearest ancestor for SYSTEM.md / RULES.md / AGENTS.md; skills walk every ancestor). | `docs/config-usage.md:273-305` |
| Foreign roots | **Also reads** `~/.claude`, `~/.codex`, `~/.gemini` and project `.claude/.codex/.gemini`, plus Cursor/Windsurf/Cline/Copilot/VS Code/OpenCode via capability providers (priority 100 native … 10 AGENTS.md). `.pi` is **not** in discovery. | `docs/config-usage.md:51-70`, `:88-90`, `:215-262` |
| Profiles | `~/.omp/profiles/<name>/agent`; profile sees only its own OMP config, except keybindings inherit from default. | `docs/config-usage.md:76-82` |
| XDG | Opt-in: only used if `$XDG_*_HOME/omp` already exists (`omp config init-xdg`). | `docs/config-usage.md:84` |
| Settings layers | env var on definition > runtime override > overlays (`PI_CONFIG_FILES`, `--config`) > project > global `config.yml` > default. Each setting declared once with `register({id, default, env})`. Invalid YAML is quarantined and startup fails (visible). | `docs/config-usage.md:150-196` |
| Env var scheme | Mostly **`PI_*` names** (`PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_CONFIG_FILES`, `PI_PY`…; 209 `PI_` vs 18 `OMP_` mentions in the doc). `OMP_PROFILE` wins over `PI_PROFILE`. Inside `.env` files every `OMP_X` is mirrored to `PI_X`. | `docs/environment-variables.md:525-540`; `packages/utils/src/env.ts:259-284` |
| `.env` loading | At module load, fills unset vars from: project `.env` > `~/.omp/agent/.env` > `~/.omp/.env` > `~/.env`. Project `.env` loads **unconditionally** (no trust check); project-dotenv values are stripped from child shells. | `packages/utils/src/env.ts:287-315`; `docs/environment-variables.md:11-27` |
| Trust model | **None**: `isProjectTrusted()` always returns true; project `.omp`, `.claude`, `mcp.json` (stdio commands) load without asking. Docs advise a separate profile for untrusted checkouts. `--trusted-extension` is an allowlist for extension files only. | `docs/extensions.md:289`; `docs/mcp-config.md:246-253`; `docs/extension-loading.md:131-142` |

Collision note (inferred): OMP and MMP both use `PI_CODING_AGENT_DIR` / `PI_*` names. MMP sets `PI_CODING_AGENT_DIR=$MMP_HOME/pi` (`docs/development.md:162-178`); a child `omp` launched from an MMP bash tool would inherit it and write into `~/.mmp/pi`. Worth a filter in MMP's child env.

## 5. UI / TUI

| Area | OMP vs Pi | Source |
|---|---|---|
| Package scope | pi-tui now contains the whole chat UI (chat/, ~80 overlays, status-line/, per-tool renderers, prompt/composer, welcome). | `docs/porting-from-pi-mono.md:205` [sub] |
| Renderer | History rows committed once + viewport diffed per frame (`TerminalFramePlan`); transcript blocks active → settled → committed; resize/multiplexer special cases. Width/wrap/highlight/sixel in Rust. | `docs/tui-core-renderer.md`, `packages/tui/src/utils.ts:1-10` [sub] |
| Terminal features | Kitty keyboard protocol, DEC 2026 sync output, mode 2031 dark/light, Kitty/iTerm2/Sixel images, mouse, vim mode, optional "Tern" semantic-surface protocol. | `packages/tui/src/terminal.ts`, `terminal-capabilities.ts` [sub] |
| Layout | Welcome box (recent sessions, LSP servers, tips) → transcript → tool **cards** (phases pending/running/success/warning/error; framed with status chip, shrink to one line under pressure) → HUDs above editor (todo, subagents, jobs pill) → composer (attachment chips, ghost text) → powerline **status line** (7 presets, 22 segments) replacing Pi's footer. | `packages/tui/src/render/tool-card.ts:23-27`, `status-line/presets.ts`, `modes/interactive-mode.ts:623-836` [sub] |
| Overlays | Agent Hub (Alt+A), plan-review fullscreen with TOC + annotations, rich `ask` form, model hub, tree selector. | `docs/agent-hub.md`; `packages/tui/src/overlays/*` [sub] |
| Themes | JSON themes, ~100 bundled, auto dark/light via OSC 11 / mode 2031; user themes in `~/.omp/agent/themes/` with live reload. | `docs/theme.md` [sub] |
| Keys | `keybindings.yml`; Ctrl+P cycles role models, Shift+Tab thinking level, Alt+Shift+P plan mode, Ctrl+Q queue follow-up, hold Space push-to-talk. | `docs/keybindings.md` [sub] |
| Grok-like? | Card tool output, status chips/pills, rounded boxes are in the same spirit as grok-build; no explicit Grok reference; overall closer to Claude Code / Copilot CLI (inferred). | [sub] |

## 6. Comparison with MMP today

Pi column from Pi 1.0.0 docs; Pi 0.99 assumed same unless noted (inferred). MMP column from MMP docs [sub-verified by a subagent reading `docs/development.md`, `docs/tui-design.md`, `docs/decisions.md`, `src/`].

| Capability | Pi 1.0 | OMP | MMP now | Gap / notes |
|---|---|---|---|---|
| Relationship | upstream | hard fork, own scope, last sync 2026-03 | embeds Pi SDK in-process, no fork (`docs/development.md:14-40`) | MMP follows Pi; OMP does not |
| Runtime | Node | Bun + Rust N-API | Node ≥22.19 | OMP code not directly reusable (§7) |
| Agent loop / sessions | yes (tree JSONL) | rewritten/extended | Pi's | — |
| Built-in tools | defaults read, bash, edit, write; also available grep, find, ls, powershell; inactive `codemode` (QuickJS sandbox) and `tool_search` (`docs/settings.md:40-44`, `docs/codemode.md:1-8`) | 31 incl. eval, lsp, debug, ast_edit, web_search, browser | Pi's 7 + task tools | web/LSP/eval missing |
| Subagents | none (inferred: no doc) | `task` + isolation + typed yields + Agent Hub | `mmp:task` (task/status/wait/cancel/todo), process-isolated workers, no recursion (`docs/development.md:519-585`) | no typed yields, no hub, no worktree isolation |
| Memory | none (inferred) | 4 backends, off by default | none (non-goal, `docs/development.md:928`) | — |
| Compaction | auto + branch summaries (`docs/compaction.md:1-3`) | 5-method chain incl. snapcompact | Pi's | custom compactor listed as non-goal |
| MCP | MCP extension (`docs/mcp.md` exists; per MMP `docs/mcp-design.md`, Pi's `createMcpExtension`) | own runtime, imports foreign configs | Pi's MCP + MMP config loader, `mmp mcp` (`docs/mcp-design.md`) | no SSE in MMP [sub] |
| Extensions / packages | yes (`docs/extensions.md`, `packages.md`) | yes + Pi shim + marketplace | Manifest (`npm:`/`git:`/local) | — |
| Skills | yes | many sources + managed | Manifest + 3 roots | — |
| Hooks | via extensions | legacy alias of extensions | `mmp:hooks`, 8 events, block/transform (`docs/development.md:643-756`) | MMP ahead here |
| Prompt templates | yes | yes | disabled | deliberate |
| Model roles | scoped models | 10+ roles, fallback chains | scoped models + per-agent model | roles missing |
| Approval | none (`docs/security.md:3`) | tiers, default yolo | none; hooks can block | — |
| Project trust | yes (`docs/security.md:27-82`) | **none** | Pi's trust store for `.mmp` | MMP stricter than OMP |
| Web search / fetch | none (inferred) | ~23 providers | none | gap |
| Browser / computer | none (inferred) | yes | none | — |
| LSP / DAP | none (inferred) | yes, on | none | gap |
| Collab / share | export/share | E2E relay | `/share` via gist | — |
| Stats / telemetry | none sent | local dashboard; autoqa consent | `/session` cost; nothing sent | — |
| RPC / print / SDK | yes | + rpc-ui, ACP | Pi's via `piMain` | ACP missing |
| TUI | pi-tui | own chat UI, status line, hub | grok-build full-screen on pi-tui (`docs/tui-design.md` §4) | — |
| Themes / keys | yes | 100 themes, yml keys | fixed grok dark/light; Pi keybindings in `~/.mmp/pi` | — |
| Config isolation | `~/.pi/agent`, `.pi/` | `~/.omp`, + reads `.claude/.codex/.gemini` | `~/.mmp`, never `~/.pi/agent` or `.pi/` (`docs/decisions.md:17`) | opposite philosophies |

MMP doc state: `docs/decisions.md:38` (H1) already records "grok UI is step 1, then own harness along OMP lines". `docs/development.md` §3.3 (`:89-102`) and §17 (`:915`) were partly reworded to "not in current scope" citing H1, but §3.1 (`:61-76`, "won't reimplement agent loop/sessions/compaction/tools/MCP; must not fork or copy Pi internals") and §17's non-goals (Pi fork, custom loop, custom compaction, custom MCP runtime) still contradict an OMP-style harness, as does T0 ("keep Pi layers 1-3"). `docs/tui-design.md:1-3` still says "draft, no code yet". [sub]

## 7. Borrow vs do not copy

**Constraint first:** OMP is Bun + Rust natives with its own forks of every Pi package. Borrowing OMP *code* would mean leaving Node and the official Pi packages, which conflicts with "align with official Pi first". Borrowing *designs*, implemented as MMP extensions on top of Pi 1.0, does not (inferred).

Worth borrowing (as designs on Pi's extension API):

| Idea | Why it fits MMP | OMP reference |
|---|---|---|
| Typed subagent results (`outputSchema` + `yield`) and `agent://id/path` reads | Extends existing `mmp:task` without touching Pi | `docs/tools/task.md:47-58`; `CA/internal-urls/agent-protocol.ts` |
| Agent Hub (watch / steer / kill subagents) | Matches planned task panel (`docs/tui-design.md:524`) | `docs/agent-hub.md` |
| Optional worktree isolation for subagents, merged as patch | Plain git worktree is enough on Node; skip pi-iso | `crates/pi-iso/src/lib.rs:1-21` (design only) |
| Model roles (`smol` for subagents, `slow`, `plan`) with explicit fallbacks | Small, config-only; per-agent `model:` already exists | `CA/config/model-roles.ts:46-80` |
| Approval tiers read/write/exec, per-tool policy | MMP has none; hooks already give the block point | `docs/approval-mode.md` (MMP's default mode is an open decision for the user) |
| One-declaration settings registry (`register({id, default, env})`) with provenance and visible failure on invalid config | Matches "failures visible" | `docs/config-usage.md:150-196` |
| `web_search` with a short provider chain; `read <url>` with extraction | Biggest practical tool gap | `README.md:391-448` |
| LSP diagnostics-on-write | High value, independent of Pi internals | `docs/lsp-config.md` |
| Status-line presets / tool-card phase model | Already close to grok cards | `packages/tui/src/render/tool-card.ts:23-27` |

Do not copy (conflicts with MMP rules):

| OMP behaviour | MMP rule it breaks |
|---|---|
| Reads `~/.claude`, `~/.codex`, `~/.gemini`, project `.claude/.cursor/...` config, rules, MCP, skills | No config sharing; explicit-only loading (`docs/development.md` §3.4) |
| No project trust (`isProjectTrusted()` = true); project `mcp.json` stdio commands and `.env` load unprompted | `.mmp/mmp.json` only when trusted |
| Project `.env` auto-loaded into process env; `OMP_*`→`PI_*` mirroring; reuse of `PI_*` names | Isolation from Pi; MMP's own `MMP_*` surface |
| Default approval `yolo` + unsandboxed in-process extensions presented as safe | Failures/risks visible (choose MMP's default explicitly) |
| Hard fork with manual patch ports (6-month lag) | Follow official Pi; automated upgrade gate (U1) |
| Outbound defaults: autoqa reporting to `qa.omp.sh`, install-ID to providers, public relays (`my.omp.sh`, skills.omp.sh) | MMP sends nothing; tests offline |
| ~50 subcommands, magic keywords, TTSR on by default, 100 themes | Small mmp-only CLI surface; behaviour not hidden behind magic words |
| Bun-only runtime, Rust natives | MMP is Node, ships `dist/` |
