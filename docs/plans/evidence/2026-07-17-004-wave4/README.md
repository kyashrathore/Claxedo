# Wave 4 — live integration drills (plan 2026-07-17-004)

**Date**: 2026-07-17 · **Branch**: `codex/feat-documents-core` · **Role**: read-only verification, no source owned.

Environment: claxedo-server :3001 (fresh, started via preview_start), vite :4444, board at `/` (Streams home).
`packages/workgraph` rebuilt (`bun run build`) before the run — dist is gitignored.

> **Stale-server trap (worth recording).** A claxedo-server left running from before the waves
> answered `GET /api/workgraph/changes` with **200**. Every drill below was run against a
> *restarted* server, where the same route returns **404**. Any evidence collected against a
> long-lived dev server would have been measuring pre-wave code.

## Verdicts

| Drill | Verdict | Evidence |
|---|---|---|
| (a) Zero `/changes` | **PASS** | 0 requests in a 2950+ request capture; route 404s; 0 server log hits |
| (b) Two-client propagation <2s | **PASS** | reload issued **1194ms** after a curl mutation; board updated 11→16 |
| (c) Reconnect drill | **PASS** | **exactly 1** revalidation on reconnect; board == server truth |
| (d) Attention parity | **PASS** | attention-only write → reload at **464ms**; clear → Needs you **1→0** at **845ms** |
| (e) Task-open under churn | **PASS** | **104ms** under churn (79ms baseline) with 37 concurrent reloads in flight |
| (f) Socket count at idle | **PASS** | WorkGraph **0**; total held **1** (home) / **2** (workspace context) |

## (a) Zero `/changes`

- `GET /api/workgraph/changes` → **404** on the restarted server (was 200 on the stale one).
- Full network capture (2950+ requests): **zero** matches for `/api/workgraph/changes`.
  The only `changes` substring hit is a Vite module, `ui/src/components/diff-changes.tsx`.
- WorkGraph's entire network footprint on load is **3 fetches**: `snapshot`, `defaults`, `attention`.
  No long-poll, no held workgraph request.
- Server logs: no `/changes` traffic — nothing is retrying it.
- Static: only comments reference the deleted route in `claxedo-app/src`.

## (b) Two-client propagation

Mutation issued by curl (client 2) → `POST /api/workgraph/commands` `create_stream`.

Decomposed the latency rather than trusting one number:

| Segment | Measured |
|---|---|
| mutation → `workgraph.changed` on the bus (server) | **136ms** |
| second nudge from the ~1s tip-watcher reconciler | 982ms |
| mutation → client issues `snapshot`+`attention` | **1194ms** |
| mutation → DOM shows the new card | 3486ms (**contaminated**, see below) |

The 3486ms DOM figure is **not trustworthy**: the automated pane is genuinely backgrounded, so
Chrome throttles `setTimeout` to ~1s buckets — inflating both the product's 100ms debounce and my
own 20ms DOM poller. The **1194ms fetch-layer number** is the honest one (fetch is not
timer-throttled); a real visible tab would land nearer ~250ms (136ms nudge + 100ms debounce).
Both are under the 2s DoD.

Vision-confirmed: five curl-created streams rendered on client 1; count **11 → 16 Active**.

## (c) Reconnect drill

`preview_stop` → `preview_start` under an open board:

- **Exactly one** revalidation (1 `snapshot` + 1 `attention`) fired on the SSE reconnect edge.
- Board recovered: **16 Active** == server truth (16 active streams). No silent divergence.
- While the server was down the board held last-known-good with no banner — correct, since no
  reload was attempted and nothing had actually gone stale.

Second variant (mutate during the restart window): the client reconnected *before* my curl landed,
so the nudge was delivered live rather than missed — **this did not actually exercise the
missed-nudge path**. It still showed 1 reconnect-revalidation + 1 live doorbell (not a double
revalidation), and the board recovered to 17 Active with the new stream present.

## (d) Attention parity

This was the real latent bug — attention writes append no change row, so they are invisible to any
log-derived signal.

- `POST /attention/read` (client 2) → client 1 reloaded at **464ms**. Count stayed 1, which is
  **correct**: `readAt` was set but the task is still `blocked`; read ≠ resolved.
- `POST /attention/clear` (client 2) → client 1 reloaded at **845ms**, **Needs you 1 → 0**,
  and the Needs-you panel disappeared entirely. Vision-confirmed.

## (e) Task-open under active churn

Churn: `create_stream` ~2.5/sec from curl. Board was verifiably churning — **32 snapshot reloads in
5 seconds**.

| Condition | Dialog open |
|---|---|
| Baseline (idle) | **79ms** |
| Under churn (37 concurrent reloads in flight) | **104ms** |

Vision-confirmed both times: dialog fully rendered (title, state chips, Latest attempt, Activity,
Run task) — no spinner, no stall. Against the original 25–35s task loads this is the headline result.

> A first attempt appeared to hang for 13s. It was a **missed click**, not a stall: the pane's
> screenshot space is 800x450 against a 1280x720 viewport (scale **0.625**, not 0.5). Recorded here
> so the next agent doesn't mistake it for a regression.

## (f) Socket census (lsof)

Method note: `lsof -p X -i :3001` ORs the filters — it must be `lsof -a -p X -i :3001`.
The first census was wrong for this reason. Sockets were also sampled repeatedly over time to
separate *held* streams from rotating keep-alive pool sockets.

| Scope | Held local-origin sockets |
|---|---|
| **WorkGraph** | **0** |
| Streams home, fresh load | **1** (one `/api/wr/events` central stream) |
| With a workspace context resolved | **2** (central + local workspace stream, both → :3001) |

**This answers the open question on the socket-collapse wave**: the DoD's "≤2 per tab" is **met**
without it. Wave 3's task 4 remains a real (halving central sockets when a workspace is open) but
**non-blocking** optimisation.

Caution for whoever re-runs this: PID 19584 is a *shared* Electron network process. Two sockets
survived a full page reload, proving they belong to other panes, not the app tab. Attribute
carefully or the count reads high.

## Idle cost (R3)

- **0** WorkGraph requests in a 28.8s idle window (old design: 1 poll / 25s / tab).
- **0** `workgraph.changed` nudges on the bus in a 10s idle window; change-log tip static.

## Finding (report-only): every command is double-nudged

**Measured: 10 mutations (1/sec) → 20 `workgraph.changed` nudges on the bus. Exactly 2x.**

Mechanism (`claxedo-server/src/workgraph-host/change-doorbell.ts`):

1. `instrumentWorkGraphChangeDoorbell` nudges post-commit (~136ms).
2. `createWorkGraphChangeTipWatcher.observe` then sees the tip advanced *because of that same
   command* and nudges again (~982ms).

The tip-watcher has no knowledge that the command path already nudged for that tip, so **every**
`service.execute` commit is nudged twice, ~850ms apart — too far apart for the 100ms debounce to
fold them. The module's own comment says over-nudging is safe because "a nudge for an already-seen
tip is a no-op" — that reasoning **no longer holds on the client**: §3 deleted the client cursor
machinery, so `sync-lifecycle.ts scheduleReload()` cannot recognise an already-seen tip and does a
full snapshot+attention reload for each nudge.

Impact: bounded, not a DoD failure — latency, idle cost and task-open all pass, and reload
serialisation (`inFlight`/`queued`) throttles it under load (20 nudges collapsed to 7 reload
passes). But it is ~2x redundant reload traffic during agent churn, which is exactly when the
socket budget matters. Plausible fix: have the command-path doorbell advance the tip-watcher's
baseline. **Reported only — not fixed** (Wave 4 owns no source).

## Secondary observation: snapshot reload is O(N/100) requests

At 376 streams (my churn artifact) each reload paged through the snapshot **5 times**
(`limit=100` + 4 `after=` pages) — 33 snapshot fetches ≈ 7 reload passes. At the real board size
(11 streams) it is 1 request. Not a bug and not on the DoD; noted because the doorbell design
re-reads the full snapshot per nudge, so per-nudge cost grows with board size.

## Honest limitations

1. **The pane reports `document.visibilityState: "hidden"`.** The product *intentionally* suppresses
   sync while hidden (`live() = active() && documentVisible()`), so drills (b)/(d)/(e) required
   overriding `visibilityState` to emulate a real visible tab. Initial "no reload" observations were
   this harness artifact, **not** a product bug. Real-Chrome (`claude-in-chrome`) was unavailable —
   the extension is not connected.
2. **Timer-based numbers run slow** under background throttling. Fetch-layer numbers are the honest ones.
3. **The missed-nudge path was never truly exercised** (c) — the client always won the reconnect race.
   The reconnect *revalidation* is verified; recovery from a genuinely dropped nudge is not.
4. **Two-client** = curl vs browser. Not two browser contexts; MCP was not used as client 2.
5. Screenshots were vision-reviewed inline in the session transcript. The preview pane offers no
   save-to-disk, so no image files accompany this report — every visual claim here is one I looked at.

## Cleanup

Churn created 365 probe streams in the local WorkGraph. All 365 were deleted by exact title match
(`CHURN n`, `AMP n`, `WAVE4 *`, `DRILL-B-*`, `NUDGE-TIMING/FETCH-TIMING/MISSED-NUDGE probe`);
the **11 pre-existing streams were left untouched** and the board was vision-confirmed restored to
11 Active / 0 Needs you. Attention was cleared during drill (d) and was **not** restored — its prior
state was `readAt` unset on one blocked item (`work_item_1784197328947_55`).
</content>
</invoke>
