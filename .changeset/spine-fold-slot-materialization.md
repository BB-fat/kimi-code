---
"@moonshot-ai/kimi-code": patch
---

Rework the experimental Spine folded view: a closed node now keeps the user messages inside its span in place with their media parts preserved, every closed node renders its own memory slot, and open nodes carry a boundary marker so the current tree structure stays visible in context.
