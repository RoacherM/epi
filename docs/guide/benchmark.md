# Benchmark adapter

[← 文档索引](README.md)

`scripts/benchmark-adapter.mjs` 是 MMP Core 外部的 trial adapter。它直接启动仓库内锁定的 Pi/MMP 入口，不读取 PATH 中的全局 `pi`；dataset、调度、计分规则仍由外部 runner 负责。

```bash
npm run benchmark -- \
  --variant mmp-full \
  --bundle /absolute/path/to/mmp-home-template \
  --output-dir /absolute/path/to/results/trial-001 \
  --cwd /absolute/path/to/clean-workspace \
  --model openai/gpt-4o-mini \
  --thinking off \
  --tools read,bash \
  --prompt-file /absolute/path/to/task.txt \
  --timeout-ms 600000
```

`--variant` 必须是 `pi-baseline`、`mmp-core-empty`、`mmp-rules-skills` 或 `mmp-full`。三个 MMP variant 的能力层级由传入的 bundle 内容决定；`pi-baseline` 直接运行同一依赖中锁定的 Pi（版本见 `package.json`），并关闭所有 ambient resource。

每个 MMP trial 会把 bundle 复制到独立的 `<output-dir>/mmp-home`；Pi baseline 只复制其中的 `pi/` settings/models。复制时排除 `.env*`、Pi auth/trust/session、旧 runtime capsule 和 artifacts；模型凭证必须通过 runner 环境变量注入。adapter 连续执行两次 MMP `--dry-run`，校验输出完全一致，并用规范化装配快照和实际参与 trial 的 bundle 文件 SHA-256 生成 `assemblyDigest`。

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

`events.jsonl` 是未改写的 Pi 事件流；`metadata.json` 记录版本、resolved model、时间、token/cost、tool error、压缩次数、进程/Session/capsule 泄漏检查和失败分类。退出码固定为：`0` 成功、`2` Harness/config、`3` infra/timeout、`4` model、`5` grader。可用 `--grader <executable>` 与重复的 `--grader-arg <value>` 直接传 argv；不经过 shell。
