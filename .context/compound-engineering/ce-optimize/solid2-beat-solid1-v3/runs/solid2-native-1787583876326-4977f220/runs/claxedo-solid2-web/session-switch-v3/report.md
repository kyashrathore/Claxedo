# Claxedo Solid 2 Web: session-switch-v3

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v2` (schema `f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `11e38b1fd1445d96e5a09a8008e082042db373542211da63ef9ec954e5fef022`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Run profile: `quick`
- Configured repetitions: `2`

## Session switching

### Warm session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 562.5 | 1631.8 | 1306.8 | 20 / 20 |

### Cold session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 750.2 | 2602.0 | 2438.9 | 20 / 20 |

### Warm session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 472.9 | 1583.0 | 1525.1 | 20 / 20 |

### Cold session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 1610.1 | 2898.4 | 2546.7 | 20 / 20 |

Cold means the unique destination has never been active in the measured app process. Warm means exactly one valid activation occurred before returning to control and measuring the revisit. Transcript bytes count completed text, reasoning, serialized tool input, and tool output—not database or event-envelope bytes.

### Latency growth by transcript size

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 853.8 | 2344.0 | — | 4 / 4 |
| 8 MiB (8388608 bytes) | — | — | — | 3 / 4 |
| 32 MiB (33554432 bytes) | — | — | — | 3 / 4 |
| 128 MiB (134217728 bytes) | 915.6 | 2376.3 | — | 4 / 4 |

The size sweep is within-workspace/cold and counterbalanced separately from the ascending resource-retention workload.

## Memory consumption

Active means the progressive session-switch workload in which completed historical sessions move through every configured size. No session stream or live agent is running.

| Metric | Summed process-family RSS (MiB) | Description |
|---|---:|---|
| Baseline idle average | 1610.6 | Average during the configured idle window on the fixed 1 MiB control transcript before switching. |
| Active average | 1708.2 | Average of 250 ms samples during the full progressive switch workload. |
| Active sampled maximum | 1784.9 | Largest observed sample during the active workload; not an operating-system true peak. |
| Active p95 | 1779.4 | Nearest-rank p95 across active samples. |
| Ending idle average | 1782.8 | Average during the configured idle window after returning to the same 1 MiB control transcript. |
| Retained RSS growth | 172.1 | Ending idle average minus baseline idle average; negative values remain visible. |

CPU growth and memory growth use the preserved per-switch boundary points in `result.json`.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
