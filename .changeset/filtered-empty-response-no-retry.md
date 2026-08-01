---
"@moonshot-ai/kimi-code": patch
---

Stop retrying responses blocked by the provider's safety filter; the content-filtered error now surfaces immediately instead of after the retry budget is exhausted.
