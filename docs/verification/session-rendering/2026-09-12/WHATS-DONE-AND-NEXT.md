# Session rendering: completed work and next steps

Updated 2026-09-14: the Pi missing-session-file defect was diagnosed and fixed in the driver (`20fdb18874`), and the four failing journeys rerun — they now fail at the model request on a real OpenAI 401 because brokered provider destinations are hardcoded to vendor origins ([findings](evidence/pi-session-fix/findings.md)). **The broader rendering goal is not complete.** No push or PR was made.

> [Fresh Claude and Pi rerun](current-status.md): superseded prerequisite records and the reconciliation matrix have been deleted.

## Read this first

This lane's accepted scope is **manual QA, evidence, and regression tests**, not application fixes. The separately authorized Pi version alignment is the exception. Do not describe the rendering bugs as fixed because their regressions are recorded or a neighboring control passes.

- [Observed results](index.md): 165 prior pass/fail observations remain. Setup failures are no longer multiplied into per-state blocker counts. [Fresh prerequisites and actual app checks](current-status.md) supersede the earlier login/version status.
- [Detailed findings and evidence](progress-report.md): **37 reproduced issue families, 38 qualified failing regression cases**. The cases are committed as `test.fixme` with decision-register entries, as the QA brief requires. They are unresolved defects, not green coverage.
- [Decision register](../../../../packages/claxedo-app/e2e/e2e-decisions.md): expected behavior, reproduced failure, and implementation options. Entry 62 is withdrawn; do not count it as a defect.
- **Rendering application fixes by this lane: zero.** Other work in this shared checkout may include fixes; this report does not claim ownership or acceptance of them.

## What is done

| Completed slice | Verification and boundary |
| --- | --- |
| Qualified regression inventory | 38 red cases and register entries committed. Covers question/permission replay, folding, tool rendering, transcript movement, selectors, boot handoff, first-send failures, reattach-replay duplication/resurrection, Thinking anchoring, and other findings listed in the detailed report. |
| Pi version mismatch | Runtime and sandbox pins aligned to **0.85.1**, the registry's latest version when checked on September 13. The version refusal is fixed. Pi session/resume failures remain; no sandbox image was built or deployed. [Exact results](evidence/pi-upgrade-1220/upgrade.md). |
| Browser disconnection during a tool | A real held Claude command finishes while the browser is offline; the reconnected UI settles the tool and retains the result after reload. **3 passes per identity mode, zero retries**; screenshots and sampled video reviewed. |
| Server restart during a tool | The real server restarts while a Claude command is running. The existing page must show a terminal tool error **without reload**, a follow-up must complete, and reload must preserve the error. **3 passes per identity mode, zero retries**; 12 reply screenshots, 12 tool-state screenshots, and 287 sampled video frames reviewed. |
| Duplicate chunks during live streaming | Real native Claude first and follow-up replies are paced through the model endpoint. Actual runtime text and animation-frame rendering are recorded; repeated segments fail the oracle. **12 passing cases across both modes**, zero retries. This is a control: the original intermittent duplication remains unreproduced. |
| Real terminal navigation | Creates an actual PTY from a completed chat, executes a command, reloads with retained output, returns to chat, then executes another command in the same terminal. **3 passes per mode**. This closes the earlier launcher-only test gap for this flow. |
| Busy draft | Corrected an invalid Stop expectation: nonempty busy drafts show Send. The existing test now checks canonical server busy state, exact multiline draft persistence and single submission. **Claude: 3 passes per mode**. Codex fails earlier and remains unqualified. |
| Supporting QA infrastructure | Shared visibility/geometry and streaming oracles, real network outage proxy, native clipboard preservation, Electron video support, and native model-response pacing. Earlier reviewed controls and their limits are in the detailed report. |

“Both modes” means `local-unsigned` and `test-user`. Tier R uses real app/server/harness processes with only model HTTP scripted. These results do not establish real-provider or packaged-desktop acceptance for every harness.

## Commits to retain

| Commit | Subject |
| --- | --- |
| `20fdb18874` | fix(pi): recreate a created session whose process died before its file existed |
| `7bcda14abf` | docs(e2e): record the brokered-destination blocker for the Pi journeys |
| `d12391a146` | test(e2e): qualify the rail-return replay tool-state resurrection (state 19) |
| `5ad2f53c6d` | test(e2e): qualify the Thinking-anchor pre-pending window (state 5) |
| `98cec14e1e` | test(e2e): qualify child permission dock control + Tier R repro (state 75) |
| `f324bce7d3` | test(e2e): qualify the replayed-delta text duplication (state 17) |
| `576e68805d` | test(e2e): preserve reproduced session-rendering regressions |
| `4c4cd31526` | fix(pi): align runtime and sandbox pins with 0.85.1 |
| `243e5a3aea` | test(e2e): support preserved native clipboard and desktop video |
| `5740bfb2b6` | test(e2e): script exact Markdown replies through the model endpoint |
| `dfed52f19a` | test(e2e): verify tool completion across browser disconnection |
| `0dbad3a21e` | test(e2e): observe native text chunks during live rendering |
| `35ad1a76f6` | test(e2e): verify real shell navigation and busy draft state |
| `edc362ab08` | test(e2e): verify running tool interruption across server restart |

[Verified full hashes and every changed path per commit](evidence/wrap-up/commits.json). These are the retained slices, not a claim that every checkout change belongs to this task.

## Latest gates

| Command and working directory | Result |
| --- | --- |
| Root: `bun run lint` | **0 warnings / 0 errors**, 5403 files. [Log](evidence/tool-restart-1267/lint.log). |
| Root: `bun run test:architecture-ratchets` | **Pass**: 13 tests, 5 products, 8 policies, 12616 helpers. No baseline changes. [Log](evidence/tool-restart-1267/ratchets.log). |
| App: `bun run typecheck:e2e` | **Fail: 2 production errors**, both `secretBrokering: "proxy"` assignments incompatible with `SandboxSecretBrokering`: supervisor `config-sync.ts:16` and `sandbox.ts:114`. No QA type errors. [Log](evidence/tool-restart-1267/typecheck.log). |
| App: `bun run test:architecture` | **251 pass / 1 fail**: `moduleScopeMutableState is exactly pinned`, measured 45 against 44. Owner must investigate; do not raise the baseline. [Log](evidence/terminal-busy-1263/app-architecture.log). |
| App: `CLAXEDO_E2E_AUTH_MODE=local-unsigned CLAXEDO_E2E_SERVE_MODE=build-preview PLAYWRIGHT_VIDEO=1 bun run test:e2e:real` | **34 pass / 50 fail / 8 skipped**, zero retries, 40.5 minutes. Terminal and archived. Predates the final terminal/busy-draft correction and restart test; those have separate focused qualification. [Result](evidence/full-real-1257/result.json). |
| Required three-spec core gate | **1 pass / 0 fail / 6 skipped**, zero retries. Only a terminal-launcher control ran; skipped failures are not resolved. [Exact command](evidence/core-gate-1262/result.json). |
| App production E2E build | Explicit `CLAXEDO_E2E_SERVE_MODE=build-preview bun run build:e2e` passed in 1218; later focused runners also rebuilt successfully. [Explicit build log](evidence/gates-1218/build.log). |

Final focused runs: [terminal/busy unsigned](evidence/terminal-busy-1263/result.json), [terminal/busy Test User](evidence/terminal-busy-1264/result.json), [restart unsigned first run](evidence/tool-restart-1267/result.json), [restart remaining unsigned repetitions](evidence/tool-restart-1268/result.json), [restart Test User](evidence/tool-restart-1269/result.json). Each result contains its exact invocation. Full-suite visual review and triage are incomplete; there is no release pass.

## What should happen next, in order

1. **Resume from the existing failure register and current checkout.** Recheck the original first-interaction flows against the other lane's changes before claiming fixes: logo/boot handoff, question replay, image/draft leakage, terminal navigation, permission appearance, picker width, and transcript movement. Keep fixed-size image tiles and full-image-on-click as the requested behavior. Verify the same message ID and composer geometry; movement can occur even when the composer is already present.
2. **Resolve the uncommitted mention race.** `composer-controls-1239` had 14 pass / 1 fail; `mention-diagnostic-1259` reproduced 9 pass / 1 fail with no intermediate key waits. The focused editor received ArrowDown/ArrowUp/Enter, but no mention pill appeared. Catalog hydration is a hypothesis, not a proven cause. Extra selection/focus waits masked the failure and were removed. Later 20 green diagnostic cases do not erase it. Start with [diagnosis](evidence/composer-controls-1239/diagnosis.json); finish fresh-build and both-mode qualification before committing.
3. **Triage the full real gate instead of rerunning it blindly.** Pi missing-session-file is fixed in the driver (2026-09-14, `20fdb18874`); the same four journeys now fail at the model request because the seeded `openai`/`local_only` credential yields a brokered projection whose destination origin is hardcoded to `https://api.openai.com` — the scripted model endpoint can never serve a brokered provider. That is a credential-delivery design decision (destination override or unbrokered local delivery), owned by the broker layer. Codex missing-rollout and OpenCode advertised-default-agent rejection still block downstream cases. Route those to their runtime/catalog owners; the two brokering type errors belong to the server/credential-broker owner. A separate Claude model-recovery candidate switches to Haiku but does not produce the expected resend; its trace records the config PATCH and no subsequent prompt HTTP request. [Triage](evidence/full-real-1257/model-recovery-triage.json). Confirm the controller flow and identity twin before counting a new defect.
4. **Finish missing reproductions.** The replayed-delta duplication is qualified (register 80, both auth modes red): replayed `text-delta` frames drained while the canonical fetch is in flight mint a fresh part id and append a second copy after `message.updated` un-settles the envelope. The interrupted-command family is qualified (register 77, both auth modes red): a reattached runtime stream replays the tool's start frames and the live-event store overwrites the stored terminal part to running. The Thinking-under-preceding-turn family is qualified (register 78, both auth modes red): a stale un-completed assistant envelope wins the `pending()` anchor. The child-command-denial family has a passing Tier M control plus a committed Tier R repro gated on the codex missing-rollout blocker (register 79). The archive family is narrowed to `a2a5b11917`'s already-landed hover/order hold — the historical no-op mechanism (rows moving under the pointer) is resolved by `human_turn_desc` ordering; residual silent paths (`rowForNavigation` ref miss, missing `directory` → no toast) are unproven. The **630-second Codex process** soak — process exits but Stop/Thinking/Running persist until manual Stop — still needs its own reliable regression; it is a producer-side defect (the app-server turn stayed open while the process exited) and the Tier R lane is currently gated on the same missing-rollout blocker. The live-streaming duplicate variant (chunks repeating mid-stream) also remains unverified. Current browser-outage and graceful-server-restart controls do not close runtime crashes, SIGKILL, permanent outages, heavy-history replay, or other harnesses.
5. **Complete acceptance and the separate application-fix slice.** Work through the remaining 105-state/harness variants, native desktop first interaction, first boot/dev restart, selector default/transition behavior and open-menu proportions. For each fix, remove its fixme only after the actual regression passes three times per mode with zero retries and reviewed visual evidence. Re-run gates against the final code; retain an explicit blocked verdict where credentials/environment prevent the real flow.

Fresh prerequisite results are in [current status](current-status.md). The real Claude login and app send/reload now pass; the Pi version refusal is cleared. The earlier credential/version checks are superseded.

## Pending work preserved in the shared checkout

| Path under `packages/claxedo-app/e2e/playwright/` | Remaining action |
| --- | --- |
| `core-composer-modes.spec.ts` | Attachment/draft controls and mention tests; passive keyboard diagnostic and strengthened reply oracle remain. Diagnose the race and qualify the final changes before commit. |
| `core-sidebar-tree.spec.ts` | Archive control plus terminal-row changes. Confirm hunk ownership; not every terminal hunk is established as this lane's work. Qualify before committing the whole file. |
| `core-boot-deep-links-home.spec.ts` | Fixture/test changes still need final qualification and ownership review. |
| `live-real-harness-smoke.spec.ts` | Small Playwright fixture-destructuring correction; not separately committed. |
| `desktop-dev-first-interaction.spec.ts` | Untracked prototype. Uses HTTP mocking/synthetic clipboard; do not present it as native desktop or native clipboard proof. |

A [pending patch](evidence/wrap-up/pending-qa.patch), [prototype snapshot](evidence/wrap-up/desktop-dev-first-interaction.spec.ts.txt), and [snapshot manifest](evidence/wrap-up/pending.json) preserve the work as found. They are recovery material, not qualified tests or an ownership claim. Compare with the current files before applying anything. `.claude/launch.json` contains mixed-lane changes; do not commit it wholesale. All dirty production files remain untouched by wrap-up.

## Resume safely and efficiently

- Work from the latest user-selected checkout; this QA work is in `/Users/yashvardhansingh/test/opencode` on `dev`. Do not confuse it with the separate credential-broker worktree/task. Read root `CLAUDE.md`, app `e2e/INVARIANTS.md`, and the accepted QA attachment first.
- Before every git command, unset `GIT_INDEX_FILE GIT_AUTHOR_DATE`. Use explicit add/commit paths; no stash, reset, checkout-overwrites, push, or PR.
- Use `build-preview` as requested by the QA brief. Do not add timing waits to make a race disappear. Tier M uses the shared mock; Tier R never uses `page.route`. Every successful send uses the shared reply oracle.
- Evidence is local to this checkout. Large raw reports/videos and some frame directories were preserved in byte-verified ZIPs; `archive.json`/`review-archive.json` explain how to restore paths. They are not all committed. Keep the `evidence/` directory when moving machines or worktrees.
- Expanded evidence once exceeded the architecture scanner's 1 MiB git-list buffer. Archive derived evidence with byte verification; do not change scanner limits, ignore production code, or raise baselines to pass.
- Archive each Playwright output before starting another ordinary runner. The existing local helper is `/tmp/claxedo-qa-archive-run.py`; do not copy the unrelated multi-gigabyte app `test-results` tree.

Stop here for this wrap-up. Resume the unfinished scope from this document when the user continues; this is a handoff, not a claim that all reported bugs are absent.
