---
"@moonshot-ai/kap-server": minor
---

Expose the effective experimental-flag map as `experimental_flags` on `GET /api/v1/meta`. The field is resolved per request from `IFlagService.snapshot()`, so it covers every flag source (master env, per-flag `KIMI_CODE_EXPERIMENTAL_*` env vars, the `[experimental]` config section, defaults) and flips live when the config section is written — unlike the `experimental` section of `GET /config`, which only reflects persisted config. Clients (desktop/web UI) can use it to gate experimental features.
