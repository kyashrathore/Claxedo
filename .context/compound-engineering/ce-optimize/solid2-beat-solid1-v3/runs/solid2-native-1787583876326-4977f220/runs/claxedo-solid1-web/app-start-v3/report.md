# Claxedo Solid 1 Web: app-start-v3

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v2` (schema `f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `b003c3a8dc85c9254dadf6385ef0e09fd4d068bbd8ee74a81b3f9bd470b48a97`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Run profile: `quick`
- Configured repetitions: `2`

## Application start

| Application state | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---|---:|---:|---:|---:|
| First launch — new application state | 5932.7 | 6247.5 | — | 2 / 2 |
| Repeat launch — initialized application state | 5954.8 | 6962.6 | — | 2 / 2 |

Both rows launch a new process and end at the same endpoint: the 1 MiB anchor transcript is correct and painted across two presentation opportunities, and the composer accepts trusted input. The repeat row uses a cloned state snapshot that completed exactly one earlier unmeasured launch and clean shutdown.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
