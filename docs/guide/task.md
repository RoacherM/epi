# Task

[← 文档索引](README.md)

`mmp:task` 默认开启（Manifest 里 `"disable": ["mmp:task"]` 可关掉），可用工具：

```text
task
task_status
task_wait
task_cancel
todo
```

Agent profile 放在 `~/.mmp/agents/<name>.md`；可信项目可用 `<repo>/.mmp/agents/<name>.md` 按名称覆盖全局 profile：

```markdown
---
name: reviewer
description: Reviews one bounded code change
model: openai/gpt-4o-mini
tools: read,grep
timeoutSeconds: 600
---

Review only the requested change. Return findings with file and line evidence.
```


字段约束：

- `name`：`^[a-z][a-z0-9-]{0,63}$`，目录内唯一。
- `description`：必填非空字符串。
- `model`：可选 `provider/model`；缺省时使用 Parent 当前模型。
- `tools`：可选逗号分隔字符串或字符串数组；未列出的工具不会进入 Child。
- `timeoutSeconds`：可选正整数，默认 `600`。
- frontmatter 后正文是 Child system prompt。

每个 Task Child 都是包内 `dist/worker.js` 启动的独立 Node.js process，使用固定 Pi SDK 和 in-memory Session；不会加载 `mmp:task`，因此不能递归派生 Task。Parent Session 退出时会取消并回收所有 Child。
