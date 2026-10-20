# Claxedo: session-switch-walk

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event` (schema `eb77e231c036820a83586dd18e270cca068fea4da134a24ab113f1eb0f3b473b`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `d5cf1ad1b7d3d592f28f02c89d4e74547092e402971799d6cf9160dffbb6131f`
- Corpus digest: `2a41c19fd8939c8cb5ed7d933c734e903a1b61ea28f5c1228f616fda6196bfb4`
- Run profile: `publication`
- Configured repetitions: `2`

## Session switching, walking the list

| Pass | Destination | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---|---|---:|---:|---:|---:|
| First visit | 1 MiB (1048576 bytes) | 129.7 | 167.3 | 162.7 | 38 / 38 |
| First visit | 8 MiB (8388608 bytes) | 139.9 | 155.1 | 155.1 | 6 / 6 |
| First visit | 1 MiB (1048576 bytes) of long text rows | 198.6 | 218.0 | 218.0 | 4 / 4 |
| Return | 1 MiB (1048576 bytes) | 87.4 | 132.4 | 118.8 | 38 / 38 |
| Return | 8 MiB (8388608 bytes) | 106.4 | 118.2 | 118.2 | 6 / 6 |
| Return | 1 MiB (1048576 bytes) of long text rows | 153.6 | 167.8 | 167.8 | 4 / 4 |

Each step switches from a session to the one directly below it in the app's list; the first pass opens every session for the first time and the second returns to each in the same order.

## Memory consumption

Active means the progressive session-switch workload in which completed historical sessions move through every configured size. No session stream or live agent is running.

| Metric | Summed process-family RSS (MiB) | Description |
|---|---:|---|
| Baseline idle average | 1201.9 | Average during the configured idle window on the fixed 1 MiB control transcript before switching. |
| Active average | 1233.7 | Average of 250 ms samples during the full progressive switch workload. |
| Active sampled maximum | 1256.5 | Largest observed sample during the active workload; not an operating-system true peak. |
| Active p95 | 1256.5 | Nearest-rank p95 across active samples. |
| Ending idle average | 1257.0 | Average during the configured idle window after returning to the same 1 MiB control transcript. |
| Retained RSS growth | 55.1 | Ending idle average minus baseline idle average; negative values remain visible. |

CPU growth and memory growth use the preserved per-switch boundary points in `result.json`.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
