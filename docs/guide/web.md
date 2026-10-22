# 网页检索（`epi:web`）

[← 使用文档](README.md)

`epi:web` 给模型两个工具：`web_search`（检索）和 `web_fetch`（读一个网页）。和只接一个检索服务的做法不同，它**同时查所有配置了的检索源**，把结果合并去重，每条写明是哪些源找到的、什么时候发布的。设计见 [web-search-design.md](../web-search-design.md)。

默认开启；没有配置任何检索源的 key 时，模型看不到这两个工具。不想要可以在 Manifest 里 `"disable": ["epi:web"]`。

## 配置

在 `epi` 里输入 `/web`：每个检索源一行，显示开关、key 的来源、最近一次测试。选中一个源可以填 key（输入时只显示圆点）、用 DeepSeek 模型的 key、开关、删除 key、发一次测试检索。改完立即生效，不用重启。

交互模式下一个检索源都没配置时，第一次发消息前会问一次「现在配置 / 以后 / 不再提示」。离线运行时不问。

### 检索源

| 源 | key | 检索 | 读网页 |
|---|---|---|---|
| `deepseek` | [DeepSeek 开放平台](https://platform.deepseek.com) 的 API key | `POST /v1/tools/search` | `POST /v1/tools/fetch` |
| `exa` | [Exa](https://dashboard.exa.ai/api-keys) 的 API key | `POST /search` | `POST /contents` |
| MCP 检索工具 | 由 `epi:mcp` 管 | 见下文 | 不支持 |

检索源的 key 和模型服务商的 key **分开存**：放在 `~/.epi/web-auth.json`（权限 0600），不读 `deepseek` 模型服务商的 key。`/web` 里「用 DeepSeek 模型的 key」是复制一份，之后两份各自独立。

无头运行可以用环境变量，优先于文件：`EPI_WEB_DEEPSEEK_API_KEY`、`EPI_WEB_EXA_API_KEY`。

### `~/.epi/web.json`

只有全局，没有项目级（key 不该跟着仓库走）。没有这个文件时两个内置源都开着，有 key 就参与。

```json
{
  "version": 1,
  "sources": {
    "deepseek": { "enabled": true },
    "exa": { "enabled": false },
    "brave": { "kind": "mcp", "tool": "mcp__brave__search" }
  },
  "search": { "count": 8 },
  "fetch": { "order": ["deepseek", "exa"] },
  "prompt": true
}
```

- `sources` 的顺序就是并列时的优先顺序（两家给的日期一样精确时，用排在前面的）。
- `search.count`：默认返回几条（1–20），模型可以每次指定。
- `fetch.order`：读网页时按这个顺序试，第一个失败才试下一个，结果里写明前面为什么失败。
- `prompt: false`：不再问要不要配置（选「不再提示」时写入）。

文件写错（不是 JSON、未知字段、未知的源、MCP 源没写 `tool`）时启动失败，报错写明哪里错、怎么关掉 `epi:web`。

## 模型怎么用

`web_search` 的参数：

| 参数 | 说明 |
|---|---|
| `query` | 检索词 |
| `sources` | 只查这几个源，例如 `["exa"]`；不写就是全部。名字不存在或没有 key 会报参数错误并列出可用的源 |
| `count` | 返回几条，默认 8，最多 20 |
| `after` / `before` | 发布日期范围：`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD`，按本地时区。`after` 含当天，`before` 不含 |
| `recency` | `day`、`week`、`month`、`year`：最近一天、一周……不能和 `after` 一起用 |
| `sort` | `relevance`（默认）或 `newest` |
| `sites` | 只查这些站点，例如 `["github.com"]` |

结果第一行写明今天的日期和时区（模型自己并不知道今天是哪天），每条结果最前面是日期和距今多久：

```text
Searched 2026-10-22 15:40 Asia/Shanghai · after 2026-09-15 · deepseek 6, exa 5 · 2 outside the date range
1. [2026-10-20 · 2 days ago] DeepSeek Search & Fetch — https://api-docs.deepseek.com/guides/search [deepseek, exa]
   The Search API finds web pages for a query and returns structured results…
2. [date unknown] …
```

- **合并**：网址统一写法后相同的算一条；两家的分数不能直接比，所以按各自的名次融合（RRF），两家都找到的排得更靠前。
- **日期复核**：指定了日期范围时，Epi 在本地再按日期查一遍：日期已知但在范围外的去掉并计数，日期未知的保留、排在后面。晚于明天的日期不可信，当作未知并注明。两家给的日期相差超过一天时，取更精确的那个并写明另一家的说法。
- **一个源失败**：其余的结果照常返回，结果开头写明哪个源、为什么失败（`exa: 401 invalid API key`）。全部失败时工具报错。
- **离线**（`EPI_OFFLINE`、`--offline`）：两个工具都直接报离线，不发请求。

`web_fetch` 的参数是 `url` 和可选的 `fresh`（要现抓的内容，不用缓存）。Exa 会给出页面日期；DeepSeek 不给，这时如果同一会话里之前的检索结果出现过这个网址，就沿用那次的日期并注明。

## 对话区

调用行和其他工具一样一行：

```text
├─◆ search "deepseek search api" · after 2026-09-15 · 8 results · 2 out of range   ██▏·
├─◆ search "lovely-mermaid license" · 8 results · 2025-03 → 2026-10                ██▍·
├─◆ fetch exa.ai/docs/search/quickstart · 2026-08-26 · 412 lines                    █▌··
├─◆ search "epi pi sdk" · 5 results · exa ✗                                         ███·
```

`Ctrl+O` 展开后每条结果一行（日期在最前），最后一行是今天、每个源的命中数和耗时。

## MCP 检索源

`mcp.json` 里配置的 MCP 检索工具可以登记成一个检索源，和 DeepSeek、Exa 一起查、一起合并。连接、登录都由 `epi:mcp` 管，`epi:web` 只通过 Pi 调这个工具（和模型发起的调用走同一套校验和 hooks）。

```json
"sources": { "brave": { "kind": "mcp", "tool": "mcp__brave__search" } }
```

工具名是 Pi 给 MCP 工具起的名字：`mcp__<服务名>__<工具名>`。Epi 调它时传固定的参数：

```ts
{ query: string; count: number; after?: "YYYY-MM-DD"; before?: "YYYY-MM-DD"; sites?: string[] }
```

`after`、`before` 都是包含的本地日期（Epi 已经算好 `recency`）。工具不认识的字段由它自己忽略。

工具的结果（`structuredContent`，或第一个文字块里的 JSON）必须是：

```ts
{ results: { url: string; title?: string; summary?: string; snippet?: string; date?: string | null }[] }
```

顺序就是这个源的排名，`date` 用 ISO 8601。结构不对时这个源算失败，结果里写明哪里不对。MCP 源只用于检索，不能写进 `fetch.order`。

## 版本

`epi:web` 有自己的版本号（`src/extensions/web.ts` 的 `WEB_VERSION`）。

| 版本 | 变化 |
|---|---|
| 0.1.0 | 第一版：DeepSeek、Exa 和 MCP 检索源的混合检索，日期过滤与复核，`/web`，首次提示 |
