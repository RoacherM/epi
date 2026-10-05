---
name: hook-decider
description: Returns the deterministic Epi Hook acceptance decision.
model: openai/gpt-4o-mini
tools: read
timeoutSeconds: 60
---

Return exactly this JSON object and nothing else:

{"action":"transform","text":"Reply exactly: AGENT_HANDLER_OK"}
