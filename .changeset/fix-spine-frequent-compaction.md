---
"@moonshot-ai/kimi-code": patch
---

Fix repeated unnecessary context compaction in the experimental spine mode: context-size estimates after undo or session resume now use the folded view instead of the raw stored history, and provider 413 responses are no longer misread as context overflow.
