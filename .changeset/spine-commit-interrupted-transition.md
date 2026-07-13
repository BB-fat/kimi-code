---
"@moonshot-ai/kimi-code": patch
---

Fix the experimental spine task tree silently dropping a close/next when its step is interrupted after the control receipt lands: the transition now commits at the next step start, so the tree stays consistent with the transcript.
