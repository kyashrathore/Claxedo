# Full-matrix real e2e (every surface, every auth mode, every workspace kind)

Status: active
Created: 2026-08-06
Supersedes nothing. Extends `2026-08-01-001-test-tier-r-close-to-real-e2e-plan.md`
from two lanes to the complete deployment matrix, and adds the surface Tier R
never had: the packaged desktop app.

## Context

On 2026-08-05/06 a single debugging session found and fixed **twelve** defects and
left **six** more identified but open. Four of the twelve had already shipped to
users in v0.0.65. Every one of the four traced to one fact — *the packaged
renderer is a `file://` document* — and every one was **structurally undetectable**
by the existing suite, because no lane runs the packaged app: every Playwright
config points a browser at an `http://localhost` dev server, where
`window.location.protocol` is `https?:` and the whole bug class evaporates.

The rest were invisible for a second reason. Tier M mocks the transport, and the
status-dot proofs in `core-terminal.spec.ts` deliver events through the DEV-only
`window.__claxedoEmitTestEvent` seam — which hands the event straight to the bus
and bypasses the SSE fetch, stream-target selection, and frame parser. Those
specs stayed green through a period when *nothing* was delivered to a real user.
"On units it's working" was true, and useless.

This plan closes both holes: real lanes across the full matrix, and a scenario
catalogue derived from the actual defects rather than from the code's shape.

## Owner decisions (2026-08-06, recorded verbatim intent)

1. **Only the AI endpoint may be faked.** "no only thing that needs to be stubbed
   is harness called ai endpoint nothing else stubbed." A stubbed control plane
   is not acceptable. The existing relay fixtures' hand-rolled control-plane
   `createServer` must be replaced with the real `hosted-node` deployment.
2. **Split lanes; do not build one monolith.** "one real test should have
   everything… that would kill the speed of feedback loop. maybe split tests into
   multiple but it should be testing every way."
3. **No identified bug may go unnoticed.** Coverage is proved by an explicit
   defect → scenario table, not by intuition.
4. **AI screenshot judgement must not slow the loop.** Pixel-diff first;
   escalate to vision only on a non-zero diff, plus a nightly sweep.
5. **Assertions must sit on user-observable mutations, not on boot.** The owner's
   correction: "app was booting earlier also — only when i was creating a
   terminal or i was creating a session i was getting to know it is broken."
   Any assertion that can pass while the feature is unusable is deleted, not kept
   as reassurance.

## Inherited gates (from `docs/plans/goal.md`, applied verbatim)

- **UI pixel/behaviour-parity release gate** — a lane is not accepted on green
  output; its evidence must be looked at (Phase 5 automates the looking).
- **Behaviour-asserting state-machine tests** — assert the transition
  (idle → working → done), never a single sampled state.
- **Strangler/additive** — new lanes are added beside Tier M/R; nothing is
  deleted until its replacement is green.
- **Per-slice verification loop** — each phase ends with its own evidence.

## Verified architecture facts (first-hand, this session)

- Rail assertions in every real lane before 2026-08-06: **zero**.
  `real-harness-local.spec.ts`, `real-cloud-relay.spec.ts`,
  `live-real-harness-smoke.spec.ts`, `live-user-hosted-relay.spec.ts` all had 0
  occurrences of `rail-sidebar-session-row`, `data-sidebar-status`,
  `session-navigation-title`, `rail-sidebar-terminal-row`.
- **No packaged-app lane exists.** No `packages/claxedo-desktop/e2e`; no spec
  references Electron. `playwright.deployed.config.ts` is WorkGraph-only.
- `packages/claxedo-server/src/deployments/hosted-node/index.ts` composes the
  **real** control plane on `createSqliteCentralStore` — no Convex required.
- `packages/claxedo-server/src/platform/auth/auth.ts:179`
  `customVerifierAuthAdapter({issuer, audience, jwksUrl, verifier})` sits beside
  `clerkAuthAdapter` (`authority/hosted-services.ts:364`), so a lane can run real
  JWT mint + real verification against a local JWKS issuer.
- `packages/claxedo-server/src/signed-browser-relay-fixture.mjs` and
  `user-hosted-relay-fixture.mjs` already spawn a real `@claxedo/workspace-relay`
  (real EdDSA), a real host tunnel, and a real `createWorkspaceRuntimeApp` on a
  `mkdtemp` worktree — but each also hand-rolls a `createServer(...)` returning
  canned session JSON. That stub is what decision 1 removes.
- `src/app/workbench/compact-switcher/compact-switcher.tsx:27` has its **own**
  `StatusDot` keyed `data-switcher-status`, with a comment claiming it is "kept
  in sync with NavigationStatusDot" — a sync with no test behind it.
- Desktop packaging: `package:mac` → `scripts/package.ts` (full build,
  ≈5 min / 1.4 GB); `package:mac:inner` → `electron-builder` directly.
- `e2e/INVARIANTS.md` rule #1 already mandates vision-verified evidence and a
  separate `visual_verified` verdict. It has never been automated.

## Scenario catalogue

Written **once** as helpers, invoked per lane. Every scenario asserts a
user-observable outcome, with a machine-precise assertion beside it for
diagnosis.

### A — Shell integrity

| ID | Flow | Assertion |
|---|---|---|
| A1 | Transport tripwire (**diagnostic, not coverage**) | resolved API base is an http(s) origin and is NOT the document origin; `GET /api/claxedo/bootstrap` observed on the wire → 200 |
| A2 | Reload mid-session | transcript still rendered **and a subsequent send completes a full turn** |
| A3 | Cold deep link `/w/<ws>/session/<id>` | that session loads |

A1 is explicitly demoted: "shell renders" would have been green through every
defect found, because the shell renders from the local bundle. It stays only
because it fails earlier and more legibly than B1.

### B — Session lifecycle & rail

| ID | Flow | Assertion |
|---|---|---|
| B1 | Create session from draft | `POST /session` observed → 201 **and** the row becomes visible, **live, no reload**, at index 0 |
| B2 | First turn | assistant reply visibly rendered (`expectAssistantReplyVisible`) |
| B3 | Auto-title | rail title stops being `New Session`/`Untitled session` without a reload |
| B4 | Second message, same session | sends; no "Select an agent and model" |
| B5 | Re-prompt an older row (index ≥ 3) | row moves to index 0 |
| B6 | Row identity | exactly **one** row per session id (`toHaveCount(1)`) |
| B7 | Background status dot | `working` → `done` on a row that is **not** focused |
| B8 | Reload persistence | title, order, status all still correct |
| B9 | Sidebar ↔ compact-switcher parity | with the sidebar closed, the tab shows `data-switcher-status`; **both surfaces report the equal value**; transition to `done` observed on a tab already mounted while idle |

### C — Composer & harness

| ID | Flow | Assertion |
|---|---|---|
| C1 | New draft | models resolve < 5s, submit enabled, **no reload needed** |
| C4 | Draft → switch harness → reload → continue | model trigger shows a **real model name** (never "Loading models"/empty) and submit enabled; send; reload; harness trigger same + disabled, model trigger same; **second send completes a turn**; rail shows real title at index 0 |
| C3 | Request ceiling | ≤ N `agent-config/harness` requests per 10s |

### D — Terminal

| ID | Flow | Assertion |
|---|---|---|
| D1 | Create terminal | streams a live prompt within 10s **and never matches** `/Reconnecting\.\.\. \d\/6/` |
| D2 | Agent in terminal | rail row shows `working`, then settles |
| D3 | Terminal row layout | terminal `titleX` **==** session `titleX`; `dotX < titleX` |
| D4 | Terminal exit | tracked status clears |

### E — Visual

| ID | Flow | Assertion |
|---|---|---|
| E1 | Rail geometry | D3's invariants on every row type, via `getBoundingClientRect` — not CSS visibility |
| E2 | Evidence | screenshot → pixel-diff vs golden; **AI adjudicates only non-zero diffs**; nightly full sweep writes `visual_verified` |

### F — Transport per workspace kind

| ID | Assertion |
|---|---|
| F1 | Embedded: workspace stream delivers `session.lifecycle`, `agent.lifecycle`, `pty.*` |
| F2 | User-hosted: connect through real relay + host tunnel; B-group passes |
| F3 | Cloud: same through the relay; reload replays from the remote runtime |

## Lane × scenario matrix

| Lane | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| `desktop-unsigned-embedded` | A1–A3 | all | all | all | all | F1 |
| `desktop-signed-embedded-shared` | A1–A2 | all | C1, C4 | D1–D2 | E1 | F1, F2 |
| `desktop-signed-cloud` | A1–A2 | all | C1, C4 | D1–D2 | E1 | F3 |
| `web-signed-cloud` | A2–A3 | all | C1, C4 | D1–D2 | E1 | F3 |
| `web-signed-userhosted` | A2–A3 | all | C1, C4 | D1–D2 | E1 | F2 |
| nightly `live-signed-*` | all | all | all | all | E2 | F2, F3 |

`desktop-unsigned-cloud` is deliberately absent: cloud requires identity, so the
cell is believed invalid. **Owner confirmation required** before it is ruled out
permanently.

## Coverage proof — the twelve fixed defects

| # | Defect | Scenario | What goes red |
|---|---|---|---|
| 1 | `file://` renderer became its own API base | **B1** | no `POST /session`, no row |
| 2 | Session missing from sidebar | **B1** | row absent until reload |
| 3 | Reload broke the packaged app | **A2** | post-reload send never completes |
| 4 | WebSocket `Origin: file://` rejected | **D1** | `Reconnecting… 1/6` in buffer |
| 5 | Terminal hook posted a path as `workspaceId` | **D2** | dot never appears |
| 6 | Embedded dispatch → `CLAXEDO_PORT=80` | **D2** | dot never appears |
| 7 | Local workspace opened no event stream | **B1, F1** | no live row; stream carries only heartbeats |
| 8 | `session.updated` dropped at the runtime bridge | **B3** | title stuck at `New Session` |
| 9 | `config.model` wiped by wholesale cache replace | **B4, C4** | second send refused |
| 10 | Reconcile never re-sorted | **B1, B5** | newest row at index 5 |
| 11 | Dot orphaned; terminal titles misaligned | **D3, E1, E2** | `dotX` 11 vs `titleX` 41; terminal 65 ≠ session 41 |
| 12 | Solid early-return froze the glyph at mount | **B7, B9** | dot never appears on a row that started idle |

## Coverage proof — the six open issues

| # | Open issue | Scenario |
|---|---|---|
| 13 | Re-prompt doesn't bump row position | **B5** |
| 14 | Duplicate rows when the frame carries `workspaceID` | **B6** |
| 15 | Draft hangs on "Loading models" until reload | **C1, C4** |
| 16 | Composer won't fall back when config lacks a model | **B4** |
| 17 | Terminal creation hangs | **D1** |
| 18 | `agent-config/harness` polling storm | **C3** |

Adopting **B6** converts #14 from tolerated to blocking: the current
`core-claude-native-sdk-rail.spec.ts` uses `.first()` to work around it.

## Suspected, unverified (do not assert as fact)

- `compact-switcher.tsx:27` `StatusDot` has the same early-return-in-body shape
  that caused #12. Whether it freezes depends on item identity across updates.
  **Partially investigated 2026-08-06 and it makes the suspicion MORE plausible,
  not less:** the strip renders `<For each={itemIds()}>` over PRIMITIVE content
  ids, not item objects, precisely so that "an unchanged id keeps its DOM node
  and every field below updates in place" (compact-switcher.tsx:168-174). A
  preserved DOM node is exactly the condition under which a component body that
  early-returns `null` never re-runs. It still cannot be settled by reading —
  it turns on whether the enclosing `<Show>` is keyed and whether the prop read
  sits in a tracked scope — so **B9 step 6 remains the experiment**, not a claim.

---

## Phase 0 — Doctrine amendment

- [ ] This plan exists at `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md` and is linked from `docs/plans/README.md`. Progress:
- [x] `e2e/INVARIANTS.md` gains a rule: **an assertion that can pass while the feature is unusable is a defect in the suite.** Boot/render assertions may exist only as labelled diagnostics and never count as coverage. Progress:
- [x] `e2e/INVARIANTS.md` records that `window.__claxedoEmitTestEvent` / `emitClaxedoEvent` MUST NOT be the sole delivery path for any transport-dependent assertion; such proofs go through `mock.emitFlat()` or a real lane. Progress:
- [ ] New tags `@surface-desktop` / `@surface-web` registered in `SUB_SELECTOR_TAGS`, and `test:e2e:core:base` inverts them. Progress:
- [ ] `bun run test:architecture` green. Progress:

## Phase 1 — Shared oracles

- [x] `e2e/helpers/rail-oracle.ts` exports `expectRailRow({page, sessionId, …})` implementing B1/B3/B5/B6/B7/B8, returning evidence. Progress:
- [x] `e2e/helpers/geometry-oracle.ts` exports `expectRowGeometry()` implementing D3/E1 via `getBoundingClientRect`, asserting terminal `titleX === ` session `titleX` and `dotX < titleX`. Progress:
- [x] `e2e/helpers/surface-parity.ts` implements B9, asserting **equality** of `data-sidebar-status` and `data-switcher-status`, never presence on each surface independently. Progress:
- [ ] A grep ratchet bans asserting rail status any other way, mirroring the existing turn-oracle ratchet. Progress:
- [ ] Each oracle is mutation-verified: breaking the product behaviour turns it red. Recorded per oracle. Progress:

## Phase 2 — `desktop-unsigned-embedded` (the missing column)

- [x] **Precondition confirmed first:** `electron-builder.config.ts` produces an asar-packed `--dir` build whose renderer loads via `file://`. Progress: **GATE PASSED 2026-08-06.** `src/main/windows.ts:177-186` `loadWindow()` branches on `ELECTRON_RENDERER_URL`: set → `win.loadURL()` (dev, `http://localhost`); unset → `win.loadFile()` (packaged, `file://`). `asar` is never disabled in `electron-builder.config.ts` and `asarUnpack` is in use (line 154), so asar packing is on and is independent of the `--dir` target. **The enforceable rule is therefore sharper than "don't launch from source": `ELECTRON_RENDERER_URL` MUST be unset in the harness env.** A launched app whose renderer origin is not `file://` fails the lane immediately.
- [x] A `--dir` (unpacked, no DMG/notarisation) build target exists and is used by CI; the full `package:mac` path is NOT on the PR loop. Progress:
- [x] `e2e/helpers/electron-app.ts` launches the **packaged binary** via `_electron.launch({executablePath})`. Launching `electron .` on source is explicitly forbidden and enforced by the ratchet — under electron-vite dev the renderer is `http://localhost` and defects 1/3/4 vanish. Progress:
- [x] `userData` is redirected to a `mkdtemp` dir per run. **AND `CLAXEDO_DATA_DIR`** — measured 2026-08-06: isolating only Electron's profile still failed with `code: 'data_dir_already_owned', status: 409, owner: { pid: 62177 }` -> "The embedded Claxedo server did not become healthy in time", because the server keeps a separately-locked store. Rationale recorded: a stray `defaultServerUrl` persisted to `~/Library/Application Support/@claxedo/desktop/claxedo.settings.json` during the 2026-08-05 session and broke later runs; that store is shared across release and Dev channels. Progress:
- [x] The app boots **its own embedded claxedo-server** (production flow). No external server is injected. Progress:
- [ ] Only injection is the scripted model endpoint, through the harness spawn env. Progress:
- [ ] Scenarios A1–A3, B1–B9, C1/C3/C4, D1–D4, E1, F1 pass. Progress:
- [ ] **Negative proof, recorded before any fix:** reverting each of defects 1, 3, 4 individually turns this lane red, and the failing assertion is named for each. Progress:
- [ ] Lane wall-clock measured and recorded. Progress: build `--dir` = **42s / 403 MB** (vs ~5 min for full `package:mac`); 2-scenario lane run = **6.4s**. Full-scenario cost still to measure.

## Phase 3 — Real control plane in the relay fixtures

- [ ] `signed-browser-relay-fixture.mjs` and `user-hosted-relay-fixture.mjs` no longer hand-roll a control-plane `createServer`; both compose the real `hosted-node` control plane on `createSqliteCentralStore`. Progress:
- [ ] A local JWKS issuer mints real JWTs; the plane verifies them via `customVerifierAuthAdapter`. No Clerk, no Convex, no Cloudflare in the PR loop. Progress:
- [ ] The limit is documented in both fixtures: a local issuer is a **supported self-host mode, not a stub**, but Clerk-specific behaviour (token shape, JWKS rotation, session claims) is covered only by the nightly credentialed lane. Progress:
- [ ] "Shared/teammate" for user-hosted is a second identity minted by the same issuer. Progress:
- [ ] `real-cloud-relay.spec.ts` still green after the substitution. Progress:

## Phase 4 — The remaining four lanes

- [ ] `desktop-signed-embedded-shared` green. Progress:
- [ ] `desktop-signed-cloud` green. Progress:
- [ ] `web-signed-cloud` green (real web build, not the vite dev server). Progress:
- [ ] `web-signed-userhosted` green. Progress:
- [ ] Each lane is a thin configuration wrapper over Phase 1's oracles; no journey logic is duplicated per lane (reviewed, not assumed). Progress:
- [ ] Distinct port block per lane; lanes shard in parallel. Progress:
- [ ] Owner decision recorded on whether `desktop-unsigned-cloud` is a valid state. Progress:

## Phase 5 — Visual pipeline

- [ ] Oracle evidence screenshots are pixel-diffed against goldens; the PR loop runs diff only, no AI. Progress:
- [ ] A non-zero diff escalates to an AI vision adjudication that answers "intended or broken?" and writes `visual_verified`. Progress:
- [ ] A nightly full sweep judges every scenario's evidence. Progress:
- [ ] Load-bearing proof: moving the rail dot back to `left-1.5` (defect 11) produces a non-zero diff and an AI verdict of broken. Progress:

## Phase 6 — CI wiring and the per-PR split

- [ ] Desktop `--dir` build runs once per CI run and is fanned out as an artifact. Progress:
- [ ] Linux Electron runs under `xvfb`; macOS runs native. If only one OS is affordable, mac-only is accepted — the `file://` class is not OS-specific. Progress:
- [ ] Total matrix wall-clock **measured** (not estimated), and the per-PR vs on-merge split decided from that number. Progress:
- [ ] Tier L (`live-*`) is scheduled somewhere so it stops being dead coverage. Progress:

---

## Error-toast audit (2026-08-06, owner-requested)

The owner reported "so many error toasts" in earlier screenshots. Audited by
launching the packaged app and sampling at t=3/8/15/25s, reading both DOM text
and the pixels:

**Verdict: clean.** No toast, no banner, no error text at any sample. The app
renders its full shell — projects, terminal rows, composer, model picker.

The three error surfaces seen earlier in the session are all accounted for and
none is a live defect:
  - "Claxedo failed to start / The embedded Claxedo server did not become
    healthy in time" — the `data_dir_already_owned` 409 collision, fixed by
    scratching `CLAXEDO_DATA_DIR` per run (Phase 2).
  - "Session unavailable" — the same degraded boot, same fix.
  - "Select an agent and model" — sessions created by raw `curl POST /session`
    during debugging, whose `config.model` never persisted. Not reproducible
    through the UI; the underlying cache-wipe path was separately fixed (defect
    9) and is regression-guarded.

## Definition of Done

- [ ] All six lanes exist and are green.
- [ ] Every one of the twelve fixed defects has a named scenario, and each has been shown to turn that scenario red when reverted.
- [ ] Every one of the six open issues has a named scenario; issues still open are failing **visibly and deliberately** (`test.fixme` with a link here), never silently skipped.
- [ ] No lane stubs anything except the AI model HTTP endpoint.
- [ ] No assertion in the catalogue can pass while its feature is unusable — audited row by row, including the two flagged suspects (C2 "harness trigger settles", D4 "status clears").
- [ ] Journey logic exists once; lanes are configuration.
- [ ] The compact-switcher reactivity suspicion is resolved by B9 — confirmed and fixed, or disproved and the note deleted.
- [ ] Matrix wall-clock measured and the per-PR split recorded here.
- [ ] `e2e/INVARIANTS.md` amended per Phase 0 and every new spec links back to it.

## Execution: parallelize with agents & workflows

This plan is written for agent execution with **disjoint file ownership**:

- **Phase 1 oracles** are three independent files — `rail-oracle.ts`,
  `geometry-oracle.ts`, `surface-parity.ts` — one agent each, in parallel.
- **Phase 2** is the critical path and is single-owner (the Electron harness has
  no prior art). It starts **first** and runs concurrently with Phase 1.
- **Phase 3** (fixture control-plane swap) owns only the two `.mjs` fixtures and
  runs parallel to Phases 1–2.
- **Phase 4's four lanes** are pipelined, one agent per lane, once Phases 1–3
  land. They share no files.
- **Phase 5** owns only the visual pipeline and is independent throughout.

Use `Workflow` to fan out Phase 1 + Phase 3 + Phase 5 while Phase 2 proceeds,
then pipeline Phase 4's four lanes. Verification is parallel too: each lane's
negative proof (revert-a-defect → lane red) is an independent agent.

**Sequencing rule:** Phase 2's asar/`file://` precondition is a **gate**. If it
fails, stop and redesign — every downstream desktop lane inherits the premise.
