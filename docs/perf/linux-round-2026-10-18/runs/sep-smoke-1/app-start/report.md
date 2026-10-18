# Claxedo: app-start

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event` (schema `eb77e231c036820a83586dd18e270cca068fea4da134a24ab113f1eb0f3b473b`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `dd80a1cfa1fcfdd384bc0296bdcc70692b759dce3a696741ae753bca5e8e8ead`
- Corpus digest: `2a41c19fd8939c8cb5ed7d933c734e903a1b61ea28f5c1228f616fda6196bfb4`
- Run profile: `publication`
- Configured repetitions: `1`

## Application start

| Application state | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---|---:|---:|---:|---:|
| First launch — new application state | 2199.6 | 2199.6 | 2199.6 | 1 / 1 |
| Repeat launch — initialized application state | 2004.5 | 2004.5 | 2004.5 | 1 / 1 |

Both rows launch a new process and end at the same endpoint: the 1 MiB anchor transcript is correct and painted across two presentation opportunities, and the composer accepts trusted input. The repeat row uses a cloned state snapshot that completed exactly one earlier unmeasured launch and clean shutdown.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
