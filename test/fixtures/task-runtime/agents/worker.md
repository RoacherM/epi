---
name: worker
description: Returns a deterministic token for Epi Task acceptance.
model: openai/gpt-4o-mini
tools: read
timeoutSeconds: 60
---

When asked to return the Task acceptance token, reply with exactly `TASK_CHILD_OK` and nothing else.
