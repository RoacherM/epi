# Benchmark adapter

[← 文档索引](README.md)

`scripts/benchmark-adapter.mjs` 是 Epi Core 外部的 trial adapter。它直接启动仓库内锁定的 Pi/Epi 入口，不读取 PATH 中的全局 `pi`；dataset、调度、计分规则仍由外部 runner 负责。

```bash
npm run benchmark -- \
  --variant epi-full \
  --bundle /absolute/path/to/epi-home-template \
  --output-dir /absolute/path/to/results/trial-001 \
  --cwd /absolute/path/to/clean-workspace \
  --model openai/gpt-4o-mini \
  --thinking off \
  --tools read,bash \
  --prompt-file /absolute/path/to/task.txt \
  --timeout-ms 600000
```

`--variant` 必须是 `pi-baseline`、`epi-core-empty`、`epi-rules-skills` 或 `epi-full`。三个 Epi variant 的能力层级由传入的 bundle 内容决定；`pi-baseline` 直接运行同一依赖中锁定的 Pi（版本见 `package.json`），并关闭所有 ambient resource。

每个 Epi trial 会把 bundle 复制到独立的 `<output-dir>/epi-home`；Pi baseline 只复制其中的 `pi/` settings/models。复制时排除 `.env*`、Pi auth/trust/session、旧 runtime capsule 和 artifacts；模型凭证必须通过 runner 环境变量注入。adapter 连续执行两次 Epi `--dry-run`，校验输出完全一致，并用规范化装配快照和实际参与 trial 的 bundle 文件 SHA-256 生成 `assemblyDigest`。

输出目录保留：

```text
request.json
assembly.json
assembly-fingerprint.json
preflight.stdout
preflight.stderr
events.jsonl
stderr.log
metadata.json
```

`events.jsonl` 是未改写的 Pi 事件流；`metadata.json` 记录版本、resolved model、时间、token/cost、tool error、压缩次数、进程/Session/capsule 泄漏检查和失败分类。退出码固定为：`0` 成功、`2` Harness/config、`3` infra/timeout、`4` model、`5` grader、`6` cancelled。最终助手请求为 `stopReason: "aborted"` 且运行已结束时，Epi 和 Pi 都记为 `failureCategory: "cancelled"`、`success: false`；不执行 grader（`grader.status: "not-run"`），也不当作 harness 故障。`result.exitCode` 仍保留子进程原始退出码（Epi 为 1，Pi JSON 为 0）。协议/扩展错误、未结束的运行仍归 harness；外部信号、中断和超时仍归 infra。可用 `--grader <executable>` 与重复的 `--grader-arg <value>` 直接传 argv；不经过 shell。
