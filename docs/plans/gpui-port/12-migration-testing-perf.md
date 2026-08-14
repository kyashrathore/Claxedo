# 12 — Migration, testing, perf gates

## Strangler order
Electron app remains the shipping default; the GPUI app ships as a parallel
beta binary from Phase 1 (own updater channel). No in-place hybrid (no GPUI
window inside Electron): the seam is the server child, which both talk to.
User state: read-only reuse of CLAXEDO_DATA_DIR from day one (both apps can
point at the same server data), layout state via the v5 migrator (06).

## Test strategy
- **Contract tests**: recorded fixture server (reuse perf-harness mock
  fixtures + seed manifests) driven against the Rust client crate — the
  same seeds the browser lane uses, so behavior comparisons are apples to
  apples.
- **Ported unit specs**: every guard/spec named in sub-plans 03–06 (row
  reuse, offset reconnect, keybind collisions, reconcile-identity) gets a
  Rust twin BEFORE its surface ports; the TS test text is the spec.
- **Parity harness**: 02's screenshot gates per surface, both themes.
- **E2E**: the Playwright core suite's SCENARIOS re-expressed against the
  GPUI app via its accessibility/automation API (inventory which of the
  ~40 signed specs apply; unsigned core first).

## Perf gates (regression-locked from this effort's measurements)
| gate | budget | source |
|---|---|---|
| boot requests (fixture server) | ≤ 39 | Addendum 4 |
| session-switch completion | ≤ 500 ms | browser lane, 2.5x result |
| steady-state streaming | 0 tasks > 16.7 ms | 03 spike |
| terminal throughput | ≥ 20 MiB/s | HANDOFF M8 |
| terminal input p95 | ≤ 100 ms | HANDOFF M7 |
| cold start (shell ready) | ≤ Electron same-host | 01 |
| process-family RSS (corpus) | < 400 MiB target / 950 ceiling | HANDOFF §1.1 |
| binary download size | < current per-OS installers | desktop audit |

Every gate gets a runner in CI-shape from Phase 1 (Linux headless first, the
xvfb recipe from this session works for GPUI too), macOS runner per HANDOFF
§12.5 when available.
