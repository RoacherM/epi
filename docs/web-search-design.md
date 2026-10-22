# 混合检索设计（`epi:web`）

状态：**已确认**（2026-10-22），第一版实现中。用户对 §8 的答复：

- "检索肯定是都用"：配置了的源默认全部参与。
- "agent可以指定 search provider，未来可能还有其他的provider"：`web_search` 加 `sources` 参数（§4.2），源做成可扩展的注册表（§4.1）。
- "注意search mcp扩展协议；mcp目前只内置在epi里面"：主控的理解是，第三方检索可以是 Epi 自己 `mcp.json` 里配置的 MCP 工具，只要它的结果符合固定的结构（§4.5）；Epi 不对外提供 MCP 服务（§8 第 4 条不做）。理解有误请指出。
- 日期未知的结果怎么处理用户没有答复，按建议做：保留、排在后面、标出来（§4.3）。

来源：用户 2026-10-22 定的方向：
- "可以内置检索的mcp吧，支持exa/deepseek的api即可；启动的时候可以让user配置下"
- "search-api不一定和llm-provider的一致，我们这边需要做解耦，我想支持混合检索，即多个源，而不是一个，这是我们和单一search mcp的本质区别"
- "检索最重要的是日期，目前设计的时候得考虑到这部分"（日期规则见 §4.3，贯穿请求、融合、输出和界面）

接口事实于 2026-10-22 查自官方文档：[DeepSeek Search & Fetch](https://api-docs.deepseek.com/guides/search)、[Exa Search API](https://exa.ai/docs/search/quickstart.md)、[Exa MCP](https://exa.ai/docs/get-started/exa-mcp.md)。

## 1. 现状

Pi 内核没有联网工具（`docs/notes/research-websearch.md`），Epi 也没有加，模型想联网只能用 `bash` 去 `curl`。社区的 pi-web-access 把密钥存在 `~/.pi/agent/web-search.json`，违反 Epi 不读 Pi 配置的规则（dev-workflow.md §5），所以一直没装。社区方案也都是「选一个后端」，没有同时查多个源再合并的。

## 2. 目标和范围

| 做 | 不做（以后再说） |
|---|---|
| 内建扩展 `epi:web`：给模型 `web_search`、`web_fetch` 两个工具 | 本地抓取（自己发 HTTP 请求再提取正文）、无头浏览器 |
| 检索源与模型服务商**解耦**：检索源单独配置、单独存密钥 | 内置 DeepSeek、Exa 以外的 HTTP 源（以后按 §4.1 的接口加） |
| **混合检索**：同时查所有启用的源，按排名融合、去重，标明每条结果来自哪些源；模型可以用 `sources` 只查其中几个 | 把检索作为 MCP 服务对外提供（§8 第 4 条） |
| **可扩展的源**：`mcp.json` 里的 MCP 检索工具按固定协议接成一个源（§4.5） | MCP 源的抓取（第一版只接搜索） |
| **日期优先**：每条结果都带归一后的发布日期和距今多久；支持按日期范围过滤、按最新排序；结果开头写明今天的日期 | 从网页正文里自己解析日期（第一版只用源给的，见 §4.3） |
| 交互界面里的配置入口 `/web`，首次启动时提示配置 | 项目级检索配置（密钥只放全局，见 §5） |
| 调用行、展开详情、`/trace` 里看得到每个源的耗时和失败 | 把同一套检索作为 MCP 服务给 DSH、Pi 等其他 agent 用（见 §8 第 4 条） |

## 3. 为什么是内建工具，而不是一个 MCP 服务

用户说的「内置检索的 MCP」，按效果理解是：Epi 自带、开箱可配、模型能直接调用的检索能力。实现上建议做成 Epi 的内建扩展（同 `epi:task`、`epi:mcp`），直接用 `pi.registerTool` 注册两个工具，而不是另起一个 MCP 服务进程：

- 少一个进程，也少一套连接、重启和日志；
- 调用行、展开详情、`/trace` 能用 Epi 自己的渲染（§6）；
- 检索核心写成一个不依赖 Pi 的模块（`src/web/`），以后要给其他 agent 用时，包一层 MCP 服务就行（§8 第 4 条）。

## 4. 混合检索

### 4.1 检索源

每个源实现同一个接口：

```ts
interface WebSource {
  id: string;                        // "deepseek"、"exa"，或 web.json 里给 MCP 源起的名字
  kind: "deepseek" | "exa" | "mcp";
  search(request: SearchRequest, context: SourceContext): Promise<SourceHit[]>; // 按该源自己的排名排好
  fetch?(url: string, options: FetchOptions, context: SourceContext): Promise<FetchedPage>;
}
```

源由 `web.json` 的 `sources` 决定（§5）：`deepseek`、`exa` 两个 id 是内置的 HTTP 源，其余的 id 必须写 `"kind": "mcp"`（§4.5）。以后加新的 HTTP 源，就是加一个 `kind`。

| | DeepSeek | Exa |
|---|---|---|
| 搜索 | `POST https://api.deepseek.com/v1/tools/search`：`query`（1–128 字符）、`count`（1–50）、`need_content` | `POST https://api.exa.ai/search`：`query`、`numResults`、`contents: { highlights: true }` |
| 站点过滤 | 写进查询串：`site:`、`-site:`、`lang:` | 请求字段：`includeDomains`、`excludeDomains` |
| 发布日期过滤 | 写进查询串：`after:2025` / `after:2025-01-01`、`before:…`（年或日） | 请求字段：`startPublishedDate`、`endPublishedDate`（ISO 8601 时间） |
| 结果的发布日期 | `date`：UTC，RFC 3339，未知时为 `null` | `publishedDate`：ISO 8601，可能缺失 |
| 内容新鲜度 | 未说明 | `contents.maxAgeHours`：抓到的内容最多缓存多久，`0` 表示现抓；**不按发布日期过滤** |
| 结果里还有什么 | `title`、`url`、`summary`（600–800 字，给模型读的）、`snippet`、`rerank_score`（0–3）、`authority`（0–4） | `title`、`url`、`highlights`、`score` |
| 抓取 | `POST /v1/tools/fetch` → `{ title, content }`（Markdown），**不返回日期** | `POST /contents`，`text: true`，带 `publishedDate` |
| 鉴权 | `Authorization: Bearer <key>` | `Authorization: Bearer <key>` 或 `x-api-key` |
| 典型错误 | 401 key 无效、402 余额不足、403 抓取被安全策略拒绝、404 抓不到内容 | 401、429 限流 |

请求里的 `site`、`after`、`before` 这类统一参数，由各源翻译成自己的写法：DeepSeek 拼进查询串，Exa 填进请求字段（日期规则见 §4.3）。

### 4.2 融合

1. **并行查询**：所有启用的源同时发请求，每个源单独超时（默认 15 秒），取消时一起停（`AbortSignal`）。模型给了 `sources`（如 `["exa"]`）时只查这几个；名字不存在或已关闭的报参数错误，并列出可用的源，不悄悄换成别的。
2. **URL 归一**：小写主机名、去掉 `www.`、去掉末尾 `/` 和 `#…`、去掉 `utm_*` 等跟踪参数，`http` 和 `https` 视为同一页。归一后相同的结果合并成一条，保留各源给的标题和摘要。
3. **日期归一与复核**（§4.3）：每条结果的日期先归一；指定了日期范围时，Epi 在本地再查一遍，范围外的去掉并计数。
4. **排名**：默认按相关度，融合用 RRF（Reciprocal Rank Fusion）：`score = Σ 1 / (60 + 该源里的名次)`。两家给的分数不可比（DeepSeek 0–3，Exa 是另一套），所以只用各自的名次。多个源都找到的结果自然排得更靠前。分数相同时，日期新的优先，再看 DeepSeek 的 `authority`。`sort: "newest"` 时改为按日期从新到旧，日期未知的排在最后。
5. **截取**：默认返回前 8 条（`count` 可调，上限 20）。每条给模型的依次是日期、标题、URL、来源标记和一段摘要：优先用 DeepSeek 的 `summary`，没有就用 Exa 的 `highlights`。单条摘要和总长都有上限（默认单条 800 字、总共 8000 字），超出就截断并注明。
6. **来源标记**：每条写明是哪些源找到的（`[deepseek, exa]`），结果末尾附各源的命中数和耗时。

### 4.3 日期

检索结果有没有用，常常取决于它是什么时候的。模型自己并不可靠地知道「今天」是哪天，也分不清一篇三年前的文章和上周的公告。所以日期从请求、融合到输出都要处理，不能只当作一个附带字段。

**区分三种时间：**

| | 含义 | 来自 |
|---|---|---|
| 今天 | 本次检索时的本地日期和时区 | Epi 本机时钟 |
| 发布日期 | 页面声称的发布或更新时间 | DeepSeek `date`、Exa `publishedDate`；没有就是「未知」 |
| 内容新鲜度 | 抓到的正文是多久以前缓存的 | Exa `contents.maxAgeHours`；它**不能**代替发布日期过滤 |

**请求参数（`web_search`）：**

- `after`、`before`：`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD`，按本地时区理解。
- `recency`：`day`、`week`、`month`、`year` 的简写，按今天换算成 `after`。和 `after` 同时给时报参数错误，不猜哪个优先。
- `sort`：`relevance`（默认）或 `newest`。
- 翻译：DeepSeek 拼成 `after:2026-09-14`（只给到年时写 `after:2026`，给到月时写当月 1 日）。DeepSeek 的日期按 UTC 算，所以日期向外放宽一天，多出来的由本地复核去掉。DeepSeek 的查询串上限是 128 字符，日期和站点写法也算在内：拼完超长时这个源不发请求，记为失败并说明长度（`deepseek: query with filters is 140 characters, over its 128`），其余源照常查，不悄悄截掉条件。Exa 换算成本地当天 00:00 对应的 UTC 时间，填 `startPublishedDate` / `endPublishedDate`，同样向外放宽一天（Exa 把只有日期的页面标成 UTC 00:00，在 UTC 以西早于本地当天 0 点，会在服务端被滤掉；终审第 1 轮 P3-11）。
- 范围：`after` 含当天（或当月、当年）的第一天，`before` 不含：`before 2026-06-01` 是 5 月 31 日及以前。比较都按本地日历日。

**每条结果的日期归一：**

- 统一成 `{ date: "2026-06-01", precision: "day" | "time" | "year", from: "deepseek" | "exa" }`，或「未知」。时刻是 UTC 00:00:00 的按「只有日期」算（两家对只有日期的页面都这样给），显示时不换算时区，否则美国时区会显示成前一天；有具体时刻的换算成本地时间。
- **距今**：按今天算出 `4 months ago`、`3 days ago`，和日期一起给模型。
- **两个源说法不一**：合并后的结果，两边的日期相差超过 1 天时，取精度高的那个（有时刻的优先于只有日期的；精度相同取配置里排在前面的源），并写明另一个，例如 `2026-06-01 (exa: 2026-06-03)`。
- **不可信的日期**：晚于今天 1 天以上的，当作「未知」，并注明 `date looks wrong`。

**本地复核**：源的过滤不一定严格。指定了日期范围时，Epi 对每条结果再查一次：

- 日期已知、但在范围外的：去掉，并计入「2 条超出日期范围」。
- 日期未知的：默认保留，排在日期已知的后面，标 `date unknown`（是否改为去掉，见 §8 第 5 条）。

**给模型的输出**，日期放在每条的最前面，结果开头写明今天：

```text
Searched 2026-10-22 15:40 Asia/Shanghai · after 2026-09-15 · newest first · deepseek 6, exa 5 (2 outside the date range)
1. [2026-10-20 · 2 days ago] DeepSeek Search & Fetch API — api-docs.deepseek.com/guides/search [deepseek, exa]
   The Search API finds web pages for a query and returns structured results…
2. [2026-09-30 · 3 weeks ago] …
7. [date unknown] …
```

**抓取的日期**：Exa 的 `/contents` 带发布日期；DeepSeek 的 Fetch 不带。同一会话里，这个 URL 在之前的搜索结果中出现过的，沿用当时的日期，并注明来自搜索结果；否则写 `date unknown`。`web_fetch` 可选参数 `fresh: true` 表示要现抓的内容（Exa 用 `maxAgeHours: 0`）。

### 4.4 一个源失败时

符合硬规则「失败要可见，不静默兜底」：

- **部分失败**：其余源的结果照常返回，结果开头写明 `exa: 401 invalid API key`。调用行尾部显示 `· exa ✗`，不算整个工具失败。
- **全部失败**：工具报错，错误信息列出每个源的原因。
- **抓取**：按配置的顺序（默认 DeepSeek、再 Exa）。第一个失败才试下一个，并在结果里写明 `deepseek: 403 blocked by policy → exa`。这是用户配置的有序列表，不是悄悄换源；只配了一个就不试别的。
- **离线**（`EPI_OFFLINE=1`）：两个工具都直接报「离线模式」，不发请求。

### 4.5 MCP 源：检索扩展协议

用户 2026-10-22："未来可能还有其他的provider，注意search mcp扩展协议；mcp目前只内置在epi里面"。做法（主控定）：一个已经配在 Epi 自己 `mcp.json` 里的 MCP 检索工具，可以在 `web.json` 里登记成一个源，和 DeepSeek、Exa 一起并行查询、一起融合。密钥、连接、OAuth 都由 `epi:mcp` 管，`epi:web` 不碰。

```json
"sources": {
  "exa": { "enabled": true },
  "brave": { "kind": "mcp", "tool": "mcp__brave__search" }
}
```

- **调用**：通过 Pi 的 `ctx.executeTool`（和模型发起的调用走同一套校验和 hooks），参数固定为：

  ```ts
  { query: string; count: number; after?: "YYYY-MM-DD"; before?: "YYYY-MM-DD"; sites?: string[] }
  ```

  日期已经换算成本地日历日（`recency` 在 Epi 里算好）。工具不认识的字段由它自己忽略；Epi 在本地仍按日期复核（§4.3）。
- **结果**：工具的 `structuredContent`，或者它第一个文字块里的 JSON，必须是：

  ```ts
  { results: { url: string; title?: string; summary?: string; snippet?: string; date?: string | null }[] }
  ```

  `date` 用 ISO 8601 / RFC 3339，不知道就省略或给 `null`。结果大时请放进 `structuredContent`：Pi 给模型的文字超过 20KB 会从中间截断（Epi 读的是截断前的原文，但别的客户端不一定）。顺序就是这个源的排名。结构不对（不是 JSON、没有 `results`、某条没有 `url`）时这个源记为失败，原因写明哪里不对，不猜。工具本身报错（`isError`）也记为这个源失败。
- **前提**：`epi:mcp` 开着、这个工具可调用（Pi 的 MCP 工具默认是 codemode/deferred，不占模型的工具列表，但能被 `executeTool` 调到）。调不到时这个源失败：`brave: tool mcp__brave__search is not available (is the MCP server connected?)`。
- **抓取**：MCP 源第一版只用于搜索，写进 `fetch.order` 报配置错误。
- **为什么不自己连 MCP**：MCP 只在 Epi 里内置（`epi:mcp`，决策 MCP1/MCP2），再连一次就是两套配置、两套 OAuth。复用 `executeTool`，MCP 的配置、登录、`/mcp` 里的开关都不变。

## 5. 配置与解耦

- **配置文件** `~/.epi/web.json`，只读全局，不读项目级（密钥不该跟着仓库走）：

  ```json
  {
    "version": 1,
    "sources": {
      "deepseek": { "enabled": true },
      "exa": { "enabled": true }
    },
    "search": { "count": 8 },
    "fetch": { "order": ["deepseek", "exa"] },
    "prompt": true
  }
  ```

  没有这个文件时按上面的默认值：两个内置源都启用，有密钥就参与。`prompt: false` 是首次提示选了「不再提示」。文件写错（不是 JSON、`version` 不是 1、未知字段、未知的内置源、MCP 源没写 `tool`）时启动失败，报错附「改正文件，或用 `disable` 关掉 `epi:web`」（同 `mcp.json`、`hooks.json`）。

- **密钥和模型服务商分开存**：放在单独的 `~/.epi/web-auth.json`（权限 0600），**不复用** `deepseek` 模型服务商的 key。`/web` 配置时可以选「复制 DeepSeek 模型的 key」，复制后两份各自独立。草案原来建议放进 `~/.epi/pi/auth.json`，实现时主控改了（2026-10-22）：Pi 只导出读 `auth.json` 的函数，不导出写的，自己写会绕过 Pi 对这个文件的锁；而且 `epi-web:*` 会出现在 `/logout` 的服务商列表里。
- **环境变量**（无头运行、CI 用）：`EPI_WEB_DEEPSEEK_API_KEY`、`EPI_WEB_EXA_API_KEY`，优先于文件。按 Epi 的规则不读 `PI_*`。
- **工具什么时候出现**：至少有一个源可用（内置源启用且有密钥，或登记了 MCP 源），才注册 `web_search`；至少有一个可用的抓取源，才注册 `web_fetch`。在 `/web` 里配好以后当场注册，不用重启；全部关掉以后从模型的工具列表里拿掉。工具说明里列出可用的源，模型才知道 `sources` 能填什么。没配置的用户，模型看到的工具列表和以前完全一样；system prompt 里只有内建能力的列表多了 `epi:web`。
- **Manifest**：`epi:web` 加入内建扩展列表，默认开启，可用 `"disable": ["epi:web"]` 关掉。Manifest v1 的结构不变，只是 `disable` 多认一个名字。

## 6. 交互

### 6.1 首次启动和 `/web`

- **首次启动**：`epi:web` 开启时，启动页的 CONFIGURE 区多一项 `/web web search`（和 `/login` 一样一直在，不看有没有配置：启动页不读各能力的配置文件）。交互模式下一个源都没配置时，第一次发送消息前弹一次提示（「配置网页检索？现在 / 以后 / 不再提示」）：「现在」打开 `/web`，关掉后消息照常发出；「以后」到 Epi 重启前不再问（`/new`、`/resume` 也不问）；「不再提示」写 `"prompt": false`。`-p`、json、rpc 等非交互模式不提示。
- **`/web`**：一个选择列表，每个源一行：状态（已启用 / 缺少 key / 已关闭）、key 的来源（文件、环境变量）、最近一次测试的结果和耗时。选中一个源可以：填 key（输入时遮盖，只显示最后 4 位）、用 DeepSeek 模型的 key、开关、删掉 key、「测试」（真的发一次查询，显示命中数和耗时；MCP 源不在这里测，它只能在工具调用里调到）。

### 6.2 对话区

- **调用行**（单列排版，耗时条在右边）。指定了日期范围时，尾部写明范围；否则写结果的日期跨度：

  ```text
  ├─◆ search "deepseek search api" · after 09-15 · 8 results · 2 out of range   ██▏·
  ├─◆ search "lovely-mermaid license" · 8 results · 2025-03 → 2026-10           ██▍·
  ├─◆ fetch exa.ai/docs/search/quickstart · 2026-08-26 · 412 lines               █▌··
  ├─◆ search "epi pi sdk" · 5 results · exa ✗                                    ███·
  ```

- **展开**（`Ctrl+O`）：每条结果一行，日期在最前：日期和距今、标题、域名、来源标记；日期未知的标暗色 `date unknown`；最后一行是各源的命中数、耗时和被日期范围去掉的条数。单击「… N more」打开全文悬浮窗（复用 0.1.21 的工具输出查看器）。
- **`/trace`**：工具详情里列出每个源的请求耗时和结果（数据放在工具结果的 `details` 里，不需要改 Trace 的数据格式）。

## 7. 改动点与测试

| 位置 | 内容 |
|---|---|
| `src/web/`（新） | `sources.ts`（DeepSeek、Exa、MCP 三种源）、`dates.ts`（日期归一、距今、范围换算与复核）、`fuse.ts`（URL 归一、RRF、截取）、`config.ts`（读写 `web.json`、`web-auth.json`、环境变量）、`search.ts`（一次混合检索和抓取）。不依赖 Pi，可以单独测 |
| `src/extensions/web.ts`（新） | `epi:web`：注册工具、`/web` 命令、首次提示 |
| `src/tui/tools/` | `web_search`、`web_fetch` 的调用行和展开渲染 |
| `src/manifest.ts` | 内建列表加 `epi:web` |
| 测试 | 本地假 HTTP 服务模拟两家接口（只连 localhost，测试不联网）：融合与去重、一个源失败、全部失败、抓取顺序、超时与取消、离线、密钥优先级、没配置时不注册工具；日期：各种格式与 `null` 的归一、`recency` 换算、本地时区的日界（UTC 前后各一天）、范围外去掉并计数、未知日期的排位、未来日期、两源日期冲突、`sort: newest`、DeepSeek 查询串加上日期写法后超过 128 字符、Exa ISO 时间换算、抓取沿用搜索结果的日期；`model-snapshot` 两种情况（没配置时无变化，配置后新增两个工具）；渲染宽度 40/80/120/230 |
| 文档 | `docs/guide/web.md`（新）、README、`docs/decisions.md` 记一条决策 |

模型能看到的工具列表会变（配置以后），按规则要检查 `model-snapshot`，并考虑重跑 benchmark 基线。

## 8. 已定（原待定）

1. **默认启用哪些源**：配置了的都用（用户："检索肯定是都用"）。
2. **密钥存哪**：单独的 `~/.epi/web-auth.json`（主控定，理由见 §5）。
3. **模型能否指定源**：能，`web_search` 的 `sources`（用户："agent可以指定 search provider"）。
4. **给其他 agent 用**：不做 `epi mcp serve web`。主控对"mcp目前只内置在epi里面"的理解：MCP 只在 Epi 内部用，第三方检索通过 §4.5 的协议接进来，不对外提供。
5. **指定日期范围时，日期未知的结果怎么办**：保留，排在后面并标出（用户没有另说，按建议）。
6. **默认要不要带日期范围**：不带，由模型按问题决定；工具说明里提醒模型「问到最新、近期、版本、价格时用 `recency` 或 `after`」。
