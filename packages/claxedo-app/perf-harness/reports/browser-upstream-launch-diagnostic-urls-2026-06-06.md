# Claxedo Performance Report

Generated: 2026-06-05T19:43:08.369Z

Adapters: browser
Targets: Upstream OpenCode app
Scenario runs: 1
Failures: 1

| Adapter | Target | Scenario | Metric | p50 | p95 | Unit | Status | Video |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |

## Failures

| Adapter | Target | Scenario | Failure | Video |
| --- | --- | --- | --- | --- |
| browser | Upstream OpenCode app | launch-empty-home | browser scenario crashed: forFunction: Timeout 30000ms exceeded.; url=http://127.0.0.1:54799/; title=OpenCode; body=<empty>; consoleErrors=Failed to load resource: the server responded with a status of 500 (Internal Server Error) | Failed to load resource: the server responded with a status of 500 (Internal Server Error) | Failed to load resource: the server responded with a status of 500 (Internal Server Error); failedResponses=500 http://127.0.0.1:54799/src/utils/server-health.ts | 500 http://127.0.0.1:54799/src/pages/directory-layout.tsx | 500 http://127.0.0.1:54799/src/utils/file-request-cache.ts | 500 http://127.0.0.1:54799/src/context/global-sync/sdk-client-cache.ts | 500 http://127.0.0.1:54799/src/utils/directory-session-cache.ts | reports/videos/upstream-launch-empty-home-1.webm |
