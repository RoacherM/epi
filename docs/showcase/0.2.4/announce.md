# Epi 0.2.4 · launch copy

[← 0.2.4 showcase](README.md)

本版本没有录屏：改动位于内置 `magpie` provider 的协议兼容与模型解析层，无界面变化。

---

## Single post

epi 0.2.4: seamless cross-channel switching and Gemini 3/4 tool turns on Magpie.

• switching a session to `antigravity/*` or `auto/*` now strips foreign thought signatures and `__ts*__` tool-call suffixes across Messages, Chat Completions, Responses, and Gemini, and idempotently cloaks harness/compaction phrases
• Gemini (`/v1beta`) requests automatically fill `skip_thought_signature_validator` on unsigned cross-model `functionCall` history so Gemini 3/4 tool turns never 400
• legacy static `providers.magpie` entries in `~/.epi/pi/models.json` no longer overwrite per-model `/v1beta` or `/v1/messages` endpoints or strip catalog reasoning metadata

`epi update`

github.com/RoacherM/epi
