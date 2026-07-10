---
"@moonshot-ai/kimi-code": patch
---

Stop applying the experimental spine protocol to requests that cannot use it: compaction operations no longer get spine-folded history or the spine prompt block, and sub-agents without spine tools no longer see the protocol instructions.
