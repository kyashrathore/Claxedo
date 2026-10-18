# Claxedo: session-switch-walk

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event` (schema `eb77e231c036820a83586dd18e270cca068fea4da134a24ab113f1eb0f3b473b`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `d5cf1ad1b7d3d592f28f02c89d4e74547092e402971799d6cf9160dffbb6131f`
- Corpus digest: `2a41c19fd8939c8cb5ed7d933c734e903a1b61ea28f5c1228f616fda6196bfb4`
- Run profile: `publication`
- Configured repetitions: `6`

## Session switching, walking the list

| Pass | Destination | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---|---|---:|---:|---:|---:|
| First visit | 1 MiB (1048576 bytes) | 91.0 | 133.7 | 122.3 | 114 / 114 |
| First visit | 8 MiB (8388608 bytes) | 111.1 | 146.1 | 146.1 | 18 / 18 |
| First visit | 1 MiB (1048576 bytes) of long text rows | 109.0 | 151.0 | 151.0 | 12 / 12 |
| Return | 1 MiB (1048576 bytes) | 35.7 | 55.0 | 45.8 | 114 / 114 |
| Return | 8 MiB (8388608 bytes) | 38.0 | 46.0 | 46.0 | 18 / 18 |
| Return | 1 MiB (1048576 bytes) of long text rows | 66.8 | 85.0 | 85.0 | 12 / 12 |

Each step switches from a session to the one directly below it in the app's list; the first pass opens every session for the first time and the second returns to each in the same order.

## Memory consumption

Active means the progressive session-switch workload in which completed historical sessions move through every configured size. No session stream or live agent is running.

| Metric | Summed process-family RSS (MiB) | Description |
|---|---:|---|
| Baseline idle average | 1170.2 | Average during the configured idle window on the fixed 1 MiB control transcript before switching. |
| Active average | 1187.9 | Average of 250 ms samples during the full progressive switch workload. |
| Active sampled maximum | 1199.7 | Largest observed sample during the active workload; not an operating-system true peak. |
| Active p95 | 1199.7 | Nearest-rank p95 across active samples. |
| Ending idle average | 1184.9 | Average during the configured idle window after returning to the same 1 MiB control transcript. |
| Retained RSS growth | 14.7 | Ending idle average minus baseline idle average; negative values remain visible. |

CPU growth and memory growth use the preserved per-switch boundary points in `result.json`.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
