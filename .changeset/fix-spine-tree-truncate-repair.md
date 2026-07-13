---
"@moonshot-ai/kimi-code": patch
---

Fix the experimental spine task tree breaking after undo or /clear: undo no longer drops the next tree transition, messages sent after an undo are no longer hidden behind a stale folded span, and clearing the context no longer leaves the model with an empty view.
