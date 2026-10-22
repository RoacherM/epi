# Epi 0.1.24 · launch copy

[← 0.1.24 showcase](README.md)

Attach `turn.mp4`. Model replies are scripted (`offline-demo`) and the two search APIs are local fakes; read and bash really ran.

---

## Single post

epi 0.1.24: web search that asks more than one engine, and knows what day it is.

• `web_search` queries DeepSeek and Exa at once (plus any MCP search tool you register), merges duplicates, tags each result with who found it
• dates first: every result leads with its publish date and "N days ago"; after / before / recency filters are rechecked locally, so stale pages get dropped, not trusted
• your own keys, kept apart from model providers. `/web` to set up
• running calls now show a rotating ×, and the whole transcript uses the full terminal width

`epi update`

github.com/RoacherM/epi
