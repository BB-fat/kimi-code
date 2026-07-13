---
"@moonshot-ai/kimi-code": patch
---

Fix the experimental spine task tree orphaning tool results batched in the same response as a close/next call: the folded span now ends before the transition call, so the call and its results stay visible and paired.
