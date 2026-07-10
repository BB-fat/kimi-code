---
"@moonshot-ai/kimi-code": patch
---

Surface experimental spine task-tree persistence failures instead of silently dropping them, and spell out in the accepted-receipt wording that the tree move only commits after the step completes. A node whose archive could not be written still closes, with the failure marked in its memory.
