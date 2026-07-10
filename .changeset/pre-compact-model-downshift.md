---
"@moonshot-ai/kimi-code": patch
---

Avoid wasteful auto-compactions: compaction no longer runs when a turn has already finished, and switching to a smaller-context model now compacts with the outgoing model first so the summary still fits.
