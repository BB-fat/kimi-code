---
"@moonshot-ai/kimi-code": patch
---

Compact only the current spine epoch instead of re-summarizing the full session history, and pause automatic compaction with a warning when the kept messages alone still exceed the model window instead of compacting again on every turn.
