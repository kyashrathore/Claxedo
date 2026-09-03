# Evidence audit — screenshots actually looked at

Date: 2026-08-06. Read-only audit, no tests run to generate new evidence.
Every PNG below was opened with the Read tool (vision) and its literal
on-screen text recorded. Nothing here is inferred from filenames alone.

## Scope actually on disk

The task named two locations. Here is what each one actually contains:

1. **`e2e/playwright/test-results/`** — **zero PNGs.** The only artifacts
   present are one `.playwright-artifacts-0/` trace bundle (a `.network`
   trace file, a `.webm` video, and a handful of `.jpeg` trace-viewer
   thumbnails). Confirmed with `find ... -iname "*.png"` → empty. This is not
   "clean" evidence, it is **no evidence** — there is nothing to look at here.
2. **`test-results/evidence/`** (top-level, i.e.
   `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/test-results/evidence/`)
   — **245 PNGs**, across 40 subdirectories, one subdirectory per spec file
   plus a handful of `zz-*` manual-debug dirs. **All 245 were read.**

**Explicitly out of scope, and not read individually:** the top-level
`test-results/` directory also holds ~492 further PNGs outside the
`evidence/` subtree — in ad hoc, dated scratch directories such as
`postwave1-verify/`, `unblock-panes/`, `debug-b1`..`debug-b8i`, `probe-*`,
`fix-*`, `upgrade-mock-*`, `gate-*`, `codex-elev/`, `codex-tip/`,
`codex-surface/`, `live/`, `live2/`. These are leftover artifacts from many
prior manual debugging sessions (not the current test suite's `evidence/`
pipeline), and were not individually opened. Naming them here rather than
silently skipping them, per the "no false positive" rule — if the owner
wants those swept too, that is a separate pass.

## Headline finding

**Every one of the 17 screenshots in `evidence/desktop-unsigned-embedded/`
shows the "Failed to load sessions for opencode" toast** — usually two or
three of them stacked. This directly contradicts
`docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`'s own
"Error-toast audit" section, which states *"Verdict: clean. No toast, no
banner, no error text at any sample."* That verdict was reached by launching
the packaged app and sampling manually at t=3/8/15/25s — it was never
checked against the screenshots this same phase's tests had already written
to disk. The screenshots disagree with the manual sample.

Literal toast bodies observed, verbatim:

- `Failed to load sessions for opencode` / `404 Not Found`
- `Failed to load sessions for opencode` / `GET http://127.0.0.1:<port>/session?directory=%2FUsers%2Fyashvardhansingh%2Ft est%2Fopencode&roots=true → 503 Service Unavailable`

This is the exact signature the task brief pre-diagnosed: 404 then 503,
because the scratch `CLAXEDO_DATA_DIR`'s embedded server has never
registered the repo directory that the **Dev channel's real** store
(`~/Library/Application Support/ai.claxedo.desktop.dev/opencode.global.dat.json`)
already lists as a project. It is a harness isolation gap, not a product
regression — but it means the lane's own evidence is currently self-failing
by the plan's Phase 0 rule ("an assertion that can pass while the feature is
unusable is a defect in the suite") if anyone were asserting on these
screenshots today. Right now nothing does; they are just recorded artifacts.

## Table: file → literal text observed → verdict

### `evidence/desktop-unsigned-embedded/` (17/17 — every file affected)

| File | Literal toast text observed | Verdict |
|---|---|---|
| a2-before-reload.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| a2-after-reload-transcript.png | "Failed to load sessions for opencode" / "GET .../session?...→ 503 Service Unavailable" | error present |
| a2-after-reload-turn2.png | same 503 toast, still showing after 2nd turn | error present |
| b2-first-turn.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| b4-second-turn.png | "Failed to load sessions for opencode" / "404 Not Found", then a 2nd toast "...→ 503 Service Unavailable" | error present |
| b5-reprompt-pane-settled.png | 3 stacked "Failed to load sessions for opencode" toasts (404, 503, 503) | error present |
| b5-repromt-reply.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| b5-seed-0.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| b5-seed-1.png | 2 stacked toasts (404, 503) | error present |
| b5-seed-2.png | 2 stacked toasts (503, 503) | error present |
| b5-seed-3.png | 2 stacked toasts (503, 503) | error present |
| b7-seed-a.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| b7-seed-b.png | 1 toast "404 Not Found" + 2 more "...→ 503 Service Unavailable" stacked | error present |
| b8-seed.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| b9-seed.png | "Failed to load sessions for opencode" / "404 Not Found" | error present |
| c4-turn1.png | 2 stacked "...→ 503 Service Unavailable" toasts | error present |
| c4-turn2.png | same 2 stacked 503 toasts, still present after 2nd turn | error present |

### `evidence/web-signed-userhosted/` (8 files) — clean

No toasts, no banners, no error text in any of: a2-before-reload,
a2-after-reload-transcript, a2-after-reload-turn2, b2-first-turn,
b4-second-turn, b7-seed-a, b9-seed. This is the same A2/B2/B4/B7/B9
scenario set as the desktop lane above, run through the real user-hosted
relay lane instead — and it is clean. The toast is specific to the
desktop-unsigned-embedded lane's harness isolation gap, not to the product
behaviour under test.

### `evidence/real-harness-local/` (30 files) — clean, with one flagged anomaly

All `claude-acp-*`, `claude-sdk-*`, `codex-acp-*`, `codex-sdk-*`,
`opencode-*` reload/turn screenshots (25 files): clean, plain scripted-token
echoes, no toasts.

`turn-picker-10.png` and `turn-picker-11.png`: an **in-transcript error
card**, not a toast — "That turn didn't complete / Couldn't reach tier-real
— the request never got a response. Check your connection and try again."
with an expandable "OpenCode completed without visible assistant content"
and a **Try again** button. This reads as a genuine transient failure
against the real Tier-R harness mid-run (turn 10 of an 11-turn picker
sequence), not a deliberately-scripted negative case like the Tier M fixtures
below. Flagging it rather than asserting cause; it may be an AI-endpoint
flake or a real turn-dispatch defect, not established either way by a
screenshot alone.

### `evidence/live-real-harness-smoke/` (7 files) — clean, expected interrupt marker

`codex-sdk-turn-2.png` shows an "Interrupted" divider between two scripted
turns — this is the expected marker for a deliberately-interrupted turn in
that spec, not an error.

### Everything else in `evidence/` (187 files across 31 directories) — clean

`core-boot-deep-links-home` (14), `core-busy-abort-errors` (6, incl.
`error-card-json-envelope-unwrapped.png` and
`interrupted-divider-at-abort-part-index.png`), `core-cloud-offline-roles`
(3), `core-cloud-provisioning` (4), `core-composer-hosted-chips` (4),
`core-composer-modes` (2), `core-dead-workspace-sessions` (1), `core-docks`
(12), `core-first-prompt-local` (1), `core-harness-ownership-cloud` (10),
`core-harness-ownership-local` (10), `core-harness-rendering-matrix` (28),
`core-model-effort-agent-controls` (1, evidence file captured the
pre-toast frame — see note below), `core-panes-split-tabs` (10),
`core-permission-ruleset-delivery` (5), `core-processes` (1),
`core-session-actions` (23), `core-sidebar-tree` (1), `core-terminal` (1),
`core-timeline-rendering-scroll` (15), `core-turns-reload-recovery` (7),
`core-user-hosted-workspace` (1),
`core-workspace-lifecycle` (3), `a11y-sweep` (1), `marketing-screenshots`
(1), `mobile-smoke` (3), `grip` (1), `panedrag` (1), `probe` (1),
`zz-debug-docks2` (1), `zz-debug-history` (1), `zz-debug-todo` (1), `zz-diag`
(1), `zz-diag2` (1), `zz-diag3` (1), `zz-scratch-probe` (1), `zzz-diag3` (1).

No file in this group shows a spontaneous, unscripted toast/banner/"404"/
"503"/"Select an agent and model"/"Could not connect"/"failed to
start"/"Session unavailable"/"Reconnecting... N/6" pattern.

The *intentional* negative-path fixtures in this group, which are the thing
each of those specs is asserting on (not defects — they are the expected UI
for the scenario the test scripted):

- `mint-503-offline-retry.png` — "Can't reach the workspace runtime /
  Workspace connection failed: 503 / Retry"
- `mint-forbidden-access-denied.png` — "You don't have access to this
  workspace"
- `uh-no-host-offline.png` — "Workspace host is offline / Start it by
  running `claxedo up`..."
- `core-boot-deep-links-and-home-*-a-session-that-404s-...` (×2) —
  in-sidebar "Session unavailable" pruning, the deliberate assertion
- `does-the-save-failed-toast-appear.png` (model-effort-agent-controls) —
  "Could not save session config / {"error":"could not save session
  config"}"
- `core-turns-chip-dispatch-failure-...png` — "Failed to send prompt /
  {"error":"dispatch failed"}"
- `trigger-a-mid-turn-error` (busy-abort-errors) — "That turn didn't
  complete / Couldn't reach OpenCode gateway... overloaded_error"

## A recurring background element (not a toast, flagged for the record)

Nearly every Tier M / `mock-runtime` screenshot — the large majority of the
245, across dozens of unrelated specs — shows a persistent gray
**"Reconnecting…"** pill fixed above the composer, even in screenshots that
are otherwise a clean pass. This looks like a cosmetic artifact of how the
mock-runtime harness's WebSocket never fully settles to "connected" (the
mock never emits whatever event flips that badge off), not a live product
defect — the real-lane evidence above (`real-harness-local`,
`web-signed-userhosted`, `live-real-harness-smoke`) never shows it. Recorded
here because it is the kind of thing the owner's "so many error toasts"
complaint could also have been pattern-matching on, even though it is not
itself an error toast and not the "Failed to load sessions" toast this task
was scoped around.

## Bottom line

- **`e2e/playwright/test-results/`: no PNGs exist. Not "clean" — empty.**
- **`test-results/evidence/`: 245/245 PNGs read.** 17 of them
  (`desktop-unsigned-embedded/*`) show the "Failed to load sessions for
  opencode" toast on every single frame, confirming the owner's complaint
  and contradicting the plan doc's own "clean" verdict for that lane. 2 more
  (`real-harness-local/turn-picker-10,11`) show an unrelated in-transcript
  turn-failure card worth a second look. The remaining 226 are clean or show
  only their scenario's intended negative-path fixture.
- The already-established, non-product-defect cause for the toast (stated in
  the task brief and consistent with everything seen here): the Dev channel
  store at `~/Library/Application Support/ai.claxedo.desktop.dev/opencode.global.dat.json`
  already lists the repo as a project; the e2e harness gives the app a
  fresh, empty `CLAXEDO_DATA_DIR`, so its scratch embedded server has never
  registered that directory → 404 then 503 → stacked toasts.
  `--user-data-dir` does not isolate that store, so **three** roots need
  isolating, not two, before this lane's own evidence will actually be
  clean.
