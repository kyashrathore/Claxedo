# AccountPort overhead (measured)

**Live UX verdict, not batch wall.** Total time to drain N events is irrelevant if the user is watching a live stream. What matters:

1. **Event lag** — scheduled inject → handler (does each event arrive on time?)
2. **Keeps up** — lag stable across the run (not falling behind)
3. **First-byte** — connect / open delay when many streams start together

Arm C only: real `createAccountService.openStream` + IPC JSON envelope. Packaged Electron `sender.send` + renderer UI apply not included yet.

## How to reproduce

```bash
cd packages/claxedo-desktop
bun run perf:account-port
# custom live pace:
bun ./scripts/account-port-perf-bench.ts --sessions=20 --eps=100 --seconds=3 --bytes=2048
```

Env for production marks: `CLAXEDO_ACCOUNT_PERF=1` (+ optional `CLAXEDO_ACCOUNT_PERF_PATH`).

## Live-stream results (paced inject, 2026-08-29)

All rows: **~2048 B/event**, **3s** window, AccountPort **keeps up = YES**.

| Flow | Aggregate rate | Lag p95 tax (AP − direct) | First-byte p95 tax | Keeps up |
| --- | ---: | ---: | ---: | --- |
| 20 sess × 10/s (baseline) | 200/s | ~0 ms (noise) | ~3.4 ms | YES |
| 20 × 100/s (10× rate) | 2 000/s | ~0.1 ms | ~2.5 ms | YES |
| 200 × 10/s (10× sessions) | 2 000/s | ~2.7 ms | ~15.6 ms | YES |
| 20 × 250/s (25×) | 5 000/s | ~0.1 ms | ~2.4 ms | YES |
| 20 × 500/s (50×) | 10 000/s | ~0 ms | ~3.9 ms | YES |
| 20 × 1000/s (100× rate) | 20 000/s | ~0 ms | ~1.8 ms | YES |
| 200 × 100/s (100× sessions) | 20 000/s | ~1.0 ms | ~10.2 ms | YES |

**Reading:** AccountPort does not meaningfully hurt **live event lag** through 20k aggregate evt/s on this host (p95 tax ≤ ~3 ms). What scales with fan-out is **first-byte / open** when hundreds of streams connect at once (~10–16 ms p95 tax at 200 streams) — a connect spike, not sustained watch lag.

IPC serialize stays ~0.005–0.01 ms/event — negligible vs a frame budget.

## What batch wall was (and why it misled)

Flushing 200k events as fast as possible showed ~0.9 s AccountPort tax. That is **throughput under a synthetic dump**, not live UX. A user at 200 evt/s never waits for 200k events to finish; they care whether event *N* is late relative to when it was produced. Under paced inject, it is not.

## Okay-until (provisional, Arm C live)

- **Sustained watch:** okay through at least **20 000 aggregate evt/s** (20×1000/s or 200×100/s) — lag keeps up, p95 tax ~0–3 ms.
- **Connect fan-out:** watch first-byte when opening **hundreds** of streams together (~10–16 ms tax at 200); still under a frame or two, but the live-hurt surface if any.
- Real Electron IPC + UI apply may add more; re-measure Arm A before shipping SLOs.

## Instrumentation

| Mark | Where |
| --- | --- |
| `account.unary_main_fetch_ms` | `account-service.ts` `run` |
| `account.unary_ipc_handler_ms` | `account-ipc.ts` unary handlers |
| `account.stream_http_ok_ms` / `stream_open_to_first_byte_ms` | `account-service.ts` `openStream` |
| `account.stream_chunk_ipc_first_ms` + `{ seq, sentAt }` | `account-ipc.ts` |

## Still open

- Packaged signed desktop (Arm A) vs web authFetch (Arm B) on shared Hosted, same **lag / keeps-up** metrics.
- Renderer event-to-UI apply latency under live pace.
