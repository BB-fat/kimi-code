---
"@moonshot-ai/kimi-code": patch
---

Fix the footer token counters drifting apart: raw and projected context sizes now refresh together on every measurement and history change, and the context percentage counts the unmeasured tail.
