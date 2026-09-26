# App v2 rebuild — handoff (2026-09-24)

**Where it stands (2026-09-26).** The owner approved v2 and the swap is done on `v2/swap`; see [The swap](#the-swap-2026-09-26-branch-v2swap-off-feat-app-v2-bc83dbef91). Nothing is pushed.

- **Landed after 05:40:**
  - app plugin MCP tools with owner-only provenance and every harness connected (446612923c);
  - the packaged plugin toolchain isolated from SDK dependencies, which fixed desktop packaging (64e642b9ac);
  - `data-shell-settled` restored for the benchmark driver, deferred past boot (84c53820a6);
  - the cold session-switch regression from 9023e8c2f4 fixed, 42.5 → 26.8 ms (408f741e08).
- **Still owed:** a publication benchmark run on AC with a quiet host. Indicative run 3 ran on battery and found the two defects above.

- **Verified on 4da233314a:**
  - in `packages/claxedo-app-v2`: `bun run typecheck`, `typecheck:e2e`, `test` (183 pass), `build`, and `check` (21 of 21 steps, including the new freshness and css-invalidation checks);
  - the full e2e suite: 173 passed and 65 skipped, then flows 34 and 21 green after their selector fix (4da233314a);
  - flow 24 (dead sandbox, relay routing) 3 of 3 green on the relay merge;
  - the claxedo-server sweep and route allowlist fixed (e6d9580d53).
- **Merged in the wrap-up:**
  - checks-final, with the `src/server` budget deferred (bf6bf930c7);
  - boot CPU fixes: incremental i18n, and removal of the unread panel settle and of v1's dead preload plugin (2673bfc3b3);
  - the relay routing identity (8b58832259);
  - the perf-gate static checks and the scroll-thumb fix (35b0600844).
- **Open, each on its branch:**
  - `v2/plugin-tools`: app plugin MCP authoring reviewed and committed in `1ba04969a0`, integration through `b05be61886` merged in `ff2024064c`. Owner provenance, stale connections, member ancestry, and OpenCode/Pi tool reach are covered. Flow 40 passed three times after the merge; app-v2's 21 checks passed. Acceptance remains blocked by local-server module budgets (110/109 published, 82/80 source) and unchanged V1 theme lint; helper divergence has no growth. See [the command/results report](app-v2-parity/PLUGIN-TOOLS-VERIFICATION.md).
  - `v2/perf-gate`: the runtime budget gate (flow 40, cache-hit), 73def1a4be. It is proven red on five planted regressions and red today on recorded debt. Its `e2e/budgets/README.md` lists the debt by owner: 60 frames per idle window with the panel open, streaming computations outside the transcript, and 32 caches with no measured hit.
  - **Idle frames with the panel open: not a defect.** A trace over 10 idle seconds shows 20 DrawFrames and 48–59 BeginFrames, with 0 paints, style recalcs, rAF callbacks or timers. The panel's Files search input takes focus on open (`src/files/view/files-navigator.tsx`, `autofocus`, as v1's `files-navigator.tsx:251` does), and its caret blinks twice a second. After a blur, frames are 0. The perf gate's idle scenario must blur or budget the caret; `v2/idle-frames` has no commits and can be deleted.
  - The publication benchmark rerun on the final tip needs `v2/bench` (c77feed464) and a quiet host.
- **Found in the owner's data:** seven fixture cloud projects (`channel_fixture`, `project_channel_*`, `project_failclosed_ok`) written into `~/.claxedo/workspaces.json` and `claxedo.db` on 2026-09-24 10:06 by `claxedo-server`'s `ingress.test.ts` run outside its vitest HOME isolation. Not deleted; the owner decides.

The plan is `docs/plans/2026-09-24-001-refactor-app-rebuild-first-proof-plan.md`. Where it disagrees with the owner's parity rule, the rule wins (see [Better](#1-better-v2-looks-and-behaves-exactly-like-v1)).

## The swap (2026-09-26, branch `v2/swap` off feat/app-v2 bc83dbef91)

The owner tested v2 and approved the swap. `packages/claxedo-app-v2` is now `packages/claxedo-app` (`@claxedo/app`); v1, session-ui and storybook are deleted. `packages/ui` is still here, pending a ruling on moving the kit into the app (below).

**Deleted** (tracked `.ts/.tsx/.js/.mjs` lines, then all tracked lines):

| | Before | After |
| --- | --- | --- |
| `packages/claxedo-app` (v1) | 444,875 (484,810) | deleted |
| `packages/claxedo-app-v2/src/legacy` | 143,796 (147,730) | deleted |
| `packages/session-ui` | 32,046 (38,536) | deleted |
| `packages/storybook` | 640 (699) | deleted |
| `packages/ui` (the kit) | 30,143 (102,824) | unchanged, pending |
| The app, without `src/legacy` | 116,686 | 115,836 as `packages/claxedo-app`; budget 87,167 / 94,000 |

**What changed besides the deletions:**
- The e2e harness serves one app: no `--app`, no `e2e/parity`, no v1 coverage map. The a11y baseline lives in `e2e/harness/`, and corpus case `two-turns` has one baseline.
- The desktop renders only the app (`src/renderer/main.tsx` through the `#app` alias, the desktop account binding forced by `vite.renderer.ts`). The renderer switch, `dev:v2`, `package:mac:v2` and "Claxedo V2 Dev" are gone, and the window refuses every navigation off the app document. The diagnostics contract moved into `claxedo-desktop/src/shared`.
- Server paths only v1 read are gone: `projectName` on cloud create, the hosted `/project`, `/project/current` and `/project/:id` routes with `hostedProject()`, the hosted name heuristics, and `/api/claxedo/projects/by-directory`. The local `/project` routes stay; Claxedo MCP's tasks tool reads `/project/current`.
- CI: the v1 e2e jobs, perf-harness steps, storybook and the session-ui mermaid gate are gone. GitHub CI has no app e2e job; the macOS Crabbox lane runs `bun run e2e -- --project=desktop`.
- Ratchets: the desktop renderer policy measures the app (1,206 modules, 37 packages); desktop main 101 → 102 for the moved diagnostics contract; the helpers baseline is lowered, never raised.

**Verified on the branch:** `bun install`; root `bun run typecheck` (33 of 33); in the app `typecheck`, `typecheck:e2e`, `test`, `build`, `check` (21 of 21); the full e2e suite (183 passed, 67 skipped, 0 failed, 21.8 min); the desktop `typecheck`, `test:broad` (996 pass), `test:bundle-single`, `test:server-boot`, `test:electron-boundary`, and `package:mac -- --dir --publish never`, whose packaged app booted on an isolated profile to onboarding and, with a project, to the rail; the server packages' suites; `test:architecture-ratchets` passes product boundary and fails only the helpers step, 143 findings, each already present on feat/app-v2 (which had 4,235).

**Open after the swap:**
- The kit move: v2 renders `@opencode-ai/ui` (149 files, 11.6k TS and 9.4k CSS lines reached). Moving it into `src/ui` breaks the app's size, names and comment checks and the 94k budget unless a ruling exempts or re-bases them.
- The desktop's process-diagnostics subsystem (`src/main/diagnostics`, about 7.9k lines, plus its preload bridge) and its machine remote-access bridge have no renderer consumer now.
- The u8 packaged smokes ran a v1 Playwright spec and are removed; there is no packaged startup trace for the app yet.

## 2026-09-25 11:00: the Mac rebooted under load

- **Lost:** every lane agent, and the session scratchpad (`/private/tmp/...`): the lane briefs, the experiments' raw profiles and diffs, the benchmark verdict copies, and the probe scripts.
- **Survived:** all committed work. The benchmark's raw runs survived too, under `~/test/agent-app-benchmark/artifacts/`.
- **Saved as WIP commits:**
  - the experiments' measurement tooling, on `v2/exp-idle` (586b065f77) and `v2/exp-scroll` (567f6ca83d);
  - the in-progress edits in the shell, harness, adapter, session-screen and bench worktrees, left in place. The shell, harness and adapter lanes are relaunched on them.
- **Worktrees:** those merged into their target and clean were removed to free memory and disk. Their branches remain.
- **Servers restarted:** the daemon on 2598 (the owner's data), v2 on 4480, v1 on 4481.

## State at 06:50 on 2026-09-25 (after the night)

- **feat/app-v2 b3cadffe69.** Every lane's work is merged. Not pushed.
- **Code:**
  - live v2 is 99.3k lines (86.4k at the first handoff). The growth is ported v1 features: Tasks, Marketplace, the Settings sections, onboarding, the account cards, notifications and sounds;
  - `src/ui` is 2.8k lines (10.3k at the first handoff): v2's own copies of Toast, Tooltip, Dialog, Button, Select, TextInput, Icon and 29 unused components are deleted;
  - `src/legacy` is 143.8k lines;
  - e2e is 6.9k lines.
- **`bun run check`: 7 of 17 pass** (typecheck ×2, v2-only, adapter-boundary, no-directory-identity, access-boundary, protected-areas).
  - no-comments 1,772 (2,104 at the first handoff)
  - claxedo-names 978 (1,111)
  - one-owner 108 (239)
  - one-home-per-datum 76 (81)
  - size 59 (73)
  - no-swallowed-errors 54 (56)
  - domain-boundaries 4 (36)
  - no-polling 5
  - e2e-hygiene 3
  - budget 15 parts over
  - The shell, rail, workbench, ui, projects, accounts, onboarding and cloud folders are at 0 on most checks. The biggest remaining piles are the transcript's comments and names, which triage into the corpus first.
- **Owner bugs from the night, all fixed and merged:**
  - subagents in their turn, and as a panel tab;
  - question dock after Stop (a runtime event fix);
  - todo dock;
  - terminals in the rail and compact tabs;
  - the file-click and toggle freezes (a store write loop);
  - the Goal-less session failing to open (runtime);
  - 36 → 0 404s on session load;
  - close all tabs → New Session;
  - duplicate New Session tabs;
  - scrollbars;
  - the rail foot (account card + Usage);
  - phone rules;
  - contrast sliders only for Codex;
  - the settings regroup;
  - the Tasks and Marketplace pages;
  - Presets.
- **Performance:**
  - cold session switch 126–625 ms → 21–46 ms, from transcript-first paint;
  - the provider catalog loads once, on demand: 31–33 → 0 reads at launch for existing sessions;
  - hidden panes unmount: +9 ms per return, −15 MiB heap with 8 open;
  - the rail no longer remounts on every route change.
  - The benchmark's proper run started 06:50 on b3cadffe69, with every other lane paused.
- **Experiments (paused at the limit, results pending):** exp-stream (60 Hz while streaming), exp-scroll (scrolling and interaction), exp-idle (idle CPU, memory, start). Their worktrees are `~/test/opencode-app-v2-lanes/exp-*`, and their notes are in `scratchpad/perf/<exp>/`.

### Benchmark, publication run 1 (fast pair, 2026-09-25 07:16)

Both apps were packaged from 6d9c0a91a9 (b3cadffe69 plus driver fixes), on AC, on a quiet host with every lane paused. Every observation was valid. Raw data: `~/test/agent-app-benchmark/artifacts/comparisons/claxedo-v1-vs-v2-fast-macos-arm64-headed-20260925-0716-pub/`.

| Row | v1 median (p95) | v2 median (p95) | Verdict |
|---|---|---|---|
| App start, fresh | 1.35 s (1.52) | 1.28 s (1.33) | tie |
| App start, existing | 1.30 s (1.60) | 1.26 s (1.30) | tie |
| Unvisited switch, same ws | 83.3 ms (691.7) | 24.9 ms (33.2) | v2 3.35× faster |
| Unvisited switch, other ws | 41.5 ms (717.5) | 24.9 ms (42.6) | v2 1.67× faster |
| Return visited | 16.5 ms | 16.7 ms | tie |
| RSS idle after launch | 963 MiB | 764 MiB | v2 1.26× lower |
| RSS after workload | 1,050 MiB | 779 MiB | v2 1.35× lower |
| CPU idle | 70.0% | 0.4% | v2 lower |

**Gate so far:**
- No row goes to v1.
- **Met:** idle CPU (0.4%, target ≤ 4.4%).
- **Not met:** idle memory (764 MiB, target ≤ 700), and app start (1.28 s, target ≤ 1.1 s, a tie). exp-idle's start and memory findings are the next lever.
- Long rows and the panel open return come from the full-suite run.

### Benchmark, publication run 2 (full suite, 2026-09-25 07:19–07:41)

The build was the same (6d9c0a91a9), and the host was just as quiet. v2 had 0 invalid observations out of 380. v1 had 8 invalid, all at 128 MiB history navigation, so those two rows are withheld. There are 49 rows. Raw data: `~/test/agent-app-benchmark/artifacts/comparisons/claxedo-v1-vs-v2-user-flows-macos-arm64-headed-20260925-0719-pub/`.

**v2 wins:**
- **Unvisited switch:** 33 ms, p95 33 ms, against v1's 41 ms, p95 353–396 ms.
- **Every size switch from 1 to 128 MiB:** 1.25–1.37× faster.
- **1 MiB in one row:** 54.7 ms against 964 ms, 17.6× faster.
- **First visit in history navigation:** 1.5–1.8× faster.
- **Panel open return:** 15.6 ms against 32.3, 2.1× faster.
- **Panel open:** 53–90 ms against 135, 1.5–2.5× faster.
- **Expand-all heavy.**
- **RSS:** 775 against 1,051 MiB after launch, and 821 against 1,096 MiB after the workload.
- **CPU idle:** 0.4% against 6.8%.
- **Existing-profile start:** 1.36 against 2.22 s.

**Ties:** return to a visited session, close-panel, switch-file-tab, and the long-row 8 and 32 MiB rows (988 ms against 1.09 s, which isn't a reliable difference).

**Rows that go to v1 (gate "no row to today's app": FAILS):**

| Row | v1 | v2 |
|---|---|---|
| files-to-review, heavy | 15.2 ms | 17.4 ms |
| review-to-files, moderate | 16.6 ms | 17.9 ms |
| review-to-files, heavy | 24.9 ms | 27.9 ms |
| open-file, light (no prefetch, disclosed) | 26.1 ms | 32.4 ms |
| collapse-all, light / moderate / heavy | 24.1 / 24.4 / 24.8 ms | 26.7 / 26.9 / 27.8 ms |

**Caveat found after the run:** the packaged v2 renderer was **unminified** (a 6.72 MB main chunk; minified it's 3.67 MB). `claxedo-desktop/vite.renderer-v2.ts` never set `minify`, while v1's renderer config sets `minify: "esbuild"`. Every v2 number above comes from the unminified build. exp-idle is committing the fix with a package-step check; the rerun uses minified builds.

**Must-win targets:**
- **Met:** idle CPU, panel open return, and long rows (988 ms, target ≤ 1 s, though it ties v1).
- **Not met:** idle memory (775 MiB, target ≤ 700) and fresh start (1.41 s, target ≤ 1.1, a tie).
- **Owners:**
  - exp-scroll profiles the seven panel rows and names what v2 does extra per action;
  - exp-idle owns start and memory.
  - Either one's fixes land through the owning lane.

### Benchmark, indicative run 3 (final tip, battery, 2026-09-26 06:33–08:11 IST)

**Indicative run 3 (battery, shared host).** Both apps were packaged successfully from **`5e601eca838e228da0c0e5a59947e500a1b61a2c`**, the `v2/bench-final` merge of `feat/app-v2` at `64e642b9ac` with the existing benchmark lane. `bun install` succeeded without tracked dependency changes. Both original package commands exited 0 and passed the unchanged packaging invariants, including the SDK inventory. V2 is minified: packaged renderer `main-BwLsjd8o.js`, **3,805,262 bytes**; packaged minification and compile-cache verification returned no failures.

**Host:** Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, macOS arm64. Battery throughout: **39% → 23%** during the completed suites; other sessions remained running. The logged one-minute load ranged from **1.77 to 7.46**. Fast started at 7.46 / 13.39 / 13.42 load; full started at 4.00 / 8.00 / 10.97. `uptime` and `pmset -g batt` were recorded before and after both suites, and every ten minutes during the full suite. Exact timestamped readings are in `host-log.txt`.

**Method:** unchanged framework `b7758eedcbc293c8dd920494446fb4c69e54c68d`, headed packaged apps, sequential balanced mirrored schedule, original verified corpora, and original verdict/withholding rules. Preset `claxedo-v1-vs-v2-fast` used publication repetitions (10 startup, 3 switching), followed by `claxedo-v1-vs-v2` (5 per scenario). The publication profile specifies repetitions; this is **not a publication-grade run**. Ratios are primary; absolute medians/p95 are secondary. Ratio = **v1 median / v2 median**, so >1 favors V2. Change versus run 2 compares those ratios, never absolute times across hosts. Run 2 had 51 rows (49 scored, 2 withheld) and an unminified V2 renderer. Fast-to-run-2 comparisons also differ in corpus scope/repetitions and are descriptive. The original open-file policy is preserved: V1 hover-prefetches, while V2 does not.

| Suite | Rows | V2 wins | V1 wins | No reliable difference | Insufficient | Withheld | Invalid V1 | Invalid V2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Fast | 11 | 4 | 0 | 5 | 2 | 0 | 0/107 | 0/107 |
| Full | 51 | 5 | 5 | 6 | 0 | 35 | 0/380 | 175/380 |

**V2 full-suite wins:** App start, existing profile (1.742× v1/v2); Switch to 1 MiB in 1 row (long rows) (14.267× v1/v2); Memory (RSS) idle after launch (1.384× v1/v2); Memory (RSS) idle after the switching workload (1.403× v1/v2); CPU while idle (∞× v1/v2). The unbounded idle-CPU ratio reflects a zero measured V2 median, not proof of zero CPU use.

**Rows V1 still wins:**

| Row | V1 median | V2 median | v1/v2 | Change in ratio vs run 2 |
|---|---:|---:|---:|---:|
| Switch to unvisited session, same workspace | 41.2 ms | 58.2 ms | 0.708 | -43.3% |
| Switch to 1 MiB session | 41.2 ms | 58.1 ms | 0.709 | -44.8% |
| Switch to 8 MiB session | 40.9 ms | 50.1 ms | 0.816 | -40.4% |
| Switch to 32 MiB session | 41.3 ms | 58.2 ms | 0.710 | -43.4% |
| Switch to 128 MiB session | 41.5 ms | 58.1 ms | 0.714 | -42.9% |

**Invalid observations:** 155 × `driver-handler-error: Timed out waiting for packaged Claxedo semantic condition`; 20 × `driver-handler-error: Claxedo return navigation requires a prior first-visit of the destination in this process`. Invalid rows have no winner, ratio, or change claim. Fast has two insufficient-sample size rows (three samples per app; the rule requires four). The initial fast launch also failed before collecting observations because the fresh worktree lacked the benchmark SDK link; its evidence is retained under `attempt-0-driver-resolution/`. A local ignored `node_modules/agent-app-benchmark` link to the original framework fixed dependency resolution, after which the complete fast pair ran.

**Contract failure evidence and follow-up:** the unchanged `waitForPanelTransitionSettled` (`packages/claxedo-app/perf-harness/src/public-workspace-panel.ts:660`) requires `data-shell-settled="true"` on the existing panel shell. The active V2 producer (`packages/claxedo-app-v2/src/panel/view/panel-frame.tsx:47`) emits no settled-state attribute. The packaged renderer contains the shell and neither `data-shell-settled` nor `shellSettled`; see `panel-contract-evidence.json` and `invalid-diagnosis.md`. This explains the semantic-condition timeout path; failed first visits then invalidate return navigation. Owner: V2 panel/benchmark lane. Restore the canonical settled state from actual panel motion and verify real navigation/panel entrypoints before rerunning; do not synthesize a signal or loosen the observer.

**A quiet-host publication run on AC is still owed**, after the contract failure is repaired. Both apps ran on the same shared Mac, but changing background load and sequential measurement can still affect ratios. These results do not establish the performance acceptance gate.

**Raw data and every-row tables:** `/Users/yashvardhansingh/test/opencode-app-v2-lanes/bench-final/scratchpad/indicative-run-3/`. The `fast/` and `full/` subdirectories contain `comparison.json`, per-app/scenario results, `analysis.json`, and `report.md`. Each report gives every row's V1/V2 median and p95, ratio, unchanged verdict, invalid counts, run-2 ratio, and both absolute/relative ratio changes. `compact-table.md` combines all 62 rows. `commands.md`, `fast-command.json`, and `full-command.json` record the exact commands; `package-v1.log`, `package-v2.log`, `minification-check.json`, and `host-log.txt` retain build/host evidence. Both suite commands exited 0; their invalid observations remain explicitly withheld. No push or prohibited test suite was run.

**Required architecture check:** `bun run test:architecture-ratchets` was run after measurement and exited 1. Its 13 tests passed and all eight product-boundary policies passed; the helper ratchet then reported 4,235 findings, including three reserved helper names and a clone count of 4,148 against the existing 166 baseline. The scanner inventories `packages/`, not the scratchpad. No ceiling or baseline was changed. See `architecture-ratchets.log`. Owner/follow-up: the repository helper-canonicalization lane must resolve the source findings and rerun this check; this benchmark/report task does not claim that gate is green.

### Benchmark, publication run 4 (final tip, AC, 2026-09-26 10:19–10:51 IST)

**Interrupted; publication-grade results are not available.** The requested final-tip benchmark could not complete its fast pair during this window. Five attempts were discarded after host-monitor interruptions; the full suite was not started. There are no accepted winners, ratios, or changes versus publication run 2 / indicative run 3. Panel validity and the cold-switch recovery remain unverified by a completed run. Do not treat this section as a passing performance gate.

**Build:** `5b64bffc3b13900bfb11ca2403ca12da88967fda`, on `v2/bench-final`, merging `feat/app-v2` at `8b11cefc6f4e6a45ee7e10120f7c450f355a7f94`. This includes panel settled-state fix `84c53820a6`, cold-history read fix `408f741e08`, and packaging fix `64e642b9ac`. `bun install` exited 0 with no dependency changes. Both original macOS package commands exited 0 and passed unchanged packaging invariants. V2 is minified: `main-yaEW0OC9.js`, 3,805.76 kB in build output. Packaged minification/compile-cache verification returned `failures: []`.

**Host:** Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, macOS arm64. AC at every recorded check; battery charged from 12% to 49%. Packaging triggered a lengthy Spotlight cooldown. Before every attempted suite, the one-minute load was below 3, with two quiet readings 30 seconds apart. `uptime` and `pmset -g batt` were recorded at attempt start/stop; no attempt reached ten minutes. During attempts, AC, load and process CPU were sampled every ten seconds. The wrapper additionally enforced a conservative aggregate-external-CPU threshold of 150%, alongside an individual-process threshold of 80%. The aggregate threshold was extra operator policy, not an original framework validity rule or a user-specified numeric limit; two attempts tripped only that extra threshold. Clarification was requested before relaxing it; it was not relaxed.

| Attempt | Start IST | Start load | Stop IST | Trigger | Outcome |
|---|---|---:|---|---|---|
| 0 | 10:36:59 | 2.29 | 10:37:19 | Outside ChatGPT renderer 107.5% CPU; aggregate 201% | Discarded |
| 1 | 10:38:59 | 2.53 | 10:39:29 | macOS spindump 87.6% CPU (later 96.9%); reparented owned app also initially misattributed | Discarded |
| 2 | 10:42:26 | 2.32 | 10:43:16 | Aggregate outside CPU 196.5%; largest process 21.1% | Discarded |
| 3 | 10:44:53 | 1.74 | 10:45:33 | Aggregate outside CPU 209.9%; load 2.70; largest process 22.6% | Discarded |
| 4 | 10:50:11 | 1.62 | 10:50:31 | macOS duetexpertd 96.9% CPU; aggregate 160%; load 3.57 | Discarded |

**Invalid counts / winners:** no accepted suite exists, so accepted invalid counts and V1/V2 win counts are **not available**, not zero. Attempt 1 wrote partial startup results: V1 15/20 invalid after driver interruption, V2 0/20 invalid; every observation from that attempt is excluded. Other attempts produced no completed `result.json`. These interrupted results cannot support a per-row publication table. No panel observations were completed, and cold-switch comparisons against run 2 or run 3 remain unverified.

**Method preserved:** framework `b7758eedcbc293c8dd920494446fb4c69e54c68d`, original verified corpus digests (fast `48fbc90b47a1779d1853ea25f63adca2c3018a73745434ec27df72201dc37472`, full `beeb966459bb2b8ebeb8df1654625054decbd69a93e1d70e63addfcae610d2a1`), headed packaged apps, balanced mirrored serial schedule, fast publication repetitions (10 startup / 3 switching), and original statistical/withholding rules. Full publication preset (5 per scenario) is prepared but unrun. No benchmark budget or validity rule was loosened. The monitor was corrected to recognize reparented task-owned app processes and to stop the comparison immediately on interruption, allowing driver cleanup before terminating the owned comparison PID. Individually verified owned server survivors were terminated; no owner process, process group, or reserved owner port was touched.

**Raw attempt evidence and exact commands:** `/Users/yashvardhansingh/test/opencode-app-v2-lanes/bench-final/scratchpad/publication-run-4/`. `commands.md` records merge, install, package, copy, artifact verification, corpus verification, ratchet, wrapper commands and interruption cleanup. Each `attempt-*` directory retains expanded `fast-command.json`, config, host/process logs, contamination trigger, framework log and any partial raw output. `cooldown.log` retains the preflight wait. Analysis/report scripts are prepared but no completed comparison manifest exists. No push or prohibited test suite was run.

**Repository check:** `bun run test:architecture-ratchets` exited 1. Its 13 tests and all eight product-boundary policies passed; the helper ratchet reported the same 4,235 findings as run 3, including 4,148 cloned copies against baseline 166. No budget/baseline was changed. Owner: helper-canonicalization lane; resolve the source findings and rerun the gate.

**Follow-up / owner:** the benchmark operator needs a sustained quiet-host window (macOS background work was repeatedly active), plus resolution of the explicitly disclosed extra aggregate guard. Reuse these successfully built apps; rerun the complete fast pair and then full suite, never combine discarded attempts. Only then publish every-row medians/p95, ratios, verdicts, invalid counts and changes versus runs 2/3, and confirm panel validity and cold-switch recovery.

## The goal in four parts

The owner's words: better, performant, easy code, less LOC. Each part gives the rule, where it stands (observed on `feat/app-v2`), and what is next.

### 1. Better: v2 looks and behaves exactly like v1

**The rule (owner, 13:58):** "make sure there is no change in look and behaviour or ui". v1, today's app, is the spec. The only exceptions are the owner's approvals.

**The spec lives in this repo:**
- **Inventory:** `docs/app-v2-parity/inventory/<area>.md`, 733 rows across shell, session, composer, projects, tools, settings and extras. Each row gives v1's behavior, its v1 source and v2's status.
- **Rulings:** `docs/app-v2-parity/DECISIONS.md`, every approval, rejection and later ruling, with times.
- **The status column is stale.** It was written before the parity fixes. The commit subjects on `feat/app-v2` name what each slice closed. Re-derive the status with `bun run e2e:parity` before trusting either.
- **Screenshots aren't in the repo.** `bun run e2e:parity` regenerates them from one seeded stack.

**The method every parity slice followed:**
1. **Port, don't restyle.** `git mv` v1's component out of `packages/claxedo-app-v2/src/legacy/` into its v2 domain. Change only its data access, which goes to `@/server` (the adapter) and `@/session` (the stores). Markup, CSS, copy, keyboard handling and timing stay as v1 has them. v2's rebuilt version is deleted in the same commit.
2. **v1's look is the kit.** `@opencode-ai/ui` and `@opencode-ai/session-ui` render as they do in v1: the Codex theme by default, a 16px root.
3. **Never port v1's performance patches:** held API calls on session switch, fast-tier switching, hydration delays, deferral timers.
4. **Never port v1's global providers:** sync contexts, `useLanguage`, `authFetch`/`getClaxedoServerUrl`, global SDK clients, layout and route providers.
   - Strings come from v2's i18n: `useTranslator`, with v1's keys copied into the domain's `i18n.ts`.
   - Layout comes from the shell's registries.
5. **Verify each surface** against v1 at 1280×800 and 390×844, then run the flows it touches.

**Kept from v2 (owner, 16:45):**
- the @-mention popover that shows files;
- ~~the "Settings" row in the rail~~: removed by the owner at 21:10. A Usage button now sits beside the account card;
- v2's settings sidebar and content layout. Every v1 settings feature still has to exist in that style.

**Merged.** Lanes verified these against v1 with side-by-side screenshots; the orchestrator checked the boot and the rail live on 4480.

- **Look:**
  - v1's global CSS and `app-shell.css`, the kit's themes, Codex by default;
  - the Codex contrast look: one background, cards and dialogs derived from a Contrast value, and Light/Dark Contrast sliders in Appearance.
- **Shell:**
  - v1's URLs: `/w/<ws>/session/<id>`, `/w/<ws>/session` for a draft, `/w/<ws>/terminal/<id>`;
  - v1's rail: Tasks, Marketplace, the Projects tree with nested sessions, pin and resize;
  - the workbench header, phone drawer, landing and boot splash;
  - compact tabs, shown only while the sidebar is unpinned;
  - the palette, which is v1's `DialogSelectFile`;
  - New Terminal in the header and on a project's hover.
- **Panel and tools:**
  - v1's workspace panel, where every file opens as a panel tab;
  - Review, with its toolbar in the panel and the Changes column beside it;
  - v1's Files navigator and tree;
  - the Browser tab's chrome;
  - terminal colors, font and phone keys;
  - the terminal creator.
- **Composer:**
  - v1's frame, toolbar, + menu and Send control;
  - v1's default rule for a new session's harness, model and effort;
  - the permission chip;
  - drafts and history that survive a reload;
  - the goal, permission and question docks, and the todo tray;
  - type-to-focus;
  - `#message` links with Previous/Next;
  - the loading skeleton and "Session unavailable";
  - the image mark editor;
  - drop a file anywhere on the session pane.
- **Session screen:** no title bar (owner, 17:15). The session shares the app's background.
- **Projects:**
  - one project source, `/api/claxedo/projects`, with v1's names and an `available` field;
  - Settings → Projects with v1's Edit dialog, in place of a project page (owner, 17:26);
  - v1's folder dialog on web and desktop;
  - the composer's Project chip with v1's create form, plus the approved Name field and Account picker.
- **Transcript:**
  - moved, not rebuilt;
  - v1's typography;
  - an opened session reads its latest turn in full;
  - flow 30's corpus is identical to v1 on desktop, 8 of 8.

What remains is under [Owner-reported bugs](#owner-reported-bugs) and [Deferred](#deferred-by-the-owner).

### 2. Performant

**The rule:** v2 is fast because of its data layer (stores the server pushes into, one owner per datum), never because of v1's patches.

**The plan's gate:** agent-app-benchmark, packaged v1 against packaged v2. No row may be lost, and v2 must win:

| Row | Target | v1 |
| --- | --- | --- |
| Idle CPU | ≤ 4.4% | 8.6% |
| Long rows (8 MiB in 8 rows) | ≤ 2.4 s | 3.5 s |
| Panel open | ≤ 250 ms | 1,032 ms, 900 ms of it a hydration delay |
| Idle memory | ≤ 700 MiB | 801 MiB |
| App start | ≤ 1.1 s | 1.24 s |

**Where it stands: unmeasured.** The bench lane stopped at the first usage limit, and no packaged v2 build has been benchmarked. This acceptance criterion is unverified.

**What the code shows (observed):**
- **No v1 perf patch in live code.** There's no `requestIdleCallback`, hydration delay or held call outside `src/legacy`.
- **One timer needs its cause found.** Most surviving timers are UI feedback (a copy flash, a finish animation). `src/composer/harness/harness-options-loader.ts:134` retries after 1 s; find why the first attempt fails instead of retrying.
- **Four sites fail `no-polling`:**
  - `src/transcript/basic-tool.tsx:156`;
  - `src/transcript/message-part.tsx:359`;
  - `src/transcript/session-retry.tsx:24`;
  - `src/ui/controls/account-status.tsx:186`.
- **Opening a session reads twice:** the surface as fragments, then `view=latest-turn` (`src/server/latest-turn.ts`). That's v1's order; the benchmark's switch rows measure it.
- **Each v2 tab holds two SSE streams.** Over HTTP/1.1 (Vite dev), several tabs hit the browser's six-connection limit and a new tab hangs on "Loading". Test dev with one or two tabs. Packaged builds aren't affected.

**Next:** move the perf-harness driver to agent-app-benchmark with v2's hooks (plan, "Performance gate"), then run the verdict three times on packaged builds.

### 3. Easy code

**What holds (observed):**
- **One boundary to the server.** `src/server/` is the only code that knows routes, event names and payloads, and `adapter-boundary` passes.
- **No providers.**
  - Live v2 code has zero `createContext` calls and zero uses of v1's providers: `useLanguage`, `authFetch`, `getClaxedoServerUrl`, `useSDK`, `useGlobalSync`, `useLayout`, `useSessionParams`.
  - Access is provider-free. Only `AuthProvider` stays at the root, giving a signed server scope keyed by the principal.
- **Domains:** `src/<domain>/`, each with a narrow `index.ts`. The shell knows no feature: features register pages, pane kinds, panel views and settings sections in `src/shell/registry.ts`.
- **One owner for the session list:** `src/session/list/`, with six written reconcile rules, proven by flow 31.
- **Projects are ids.** A folder is only where a project runs.
- **Seams added in the parity phase:**
  - `usePanel().show({ kind, ... })` and `usePanel().maximized()`;
  - `panelViews` (`context` | `subagent`);
  - `useTerminals()`: items, retain, `createTerminal`, open, close, `startNew`;
  - `server.sessions.latestTurn`.

**What falls short: `bun run check` fails 10 of 17 steps** (observed at `8636e87e00`). Ported v1 code arrived with its comments, OpenCode names and long functions.

| Check | Violations | Mostly in |
| --- | --- | --- |
| no-comments | 2,104 | composer 667, transcript 646, session 466, ui 193 (transcript comments get triaged into corpus cases first) |
| claxedo-names | 1,111 | session 382, transcript 376, composer 185 |
| v2-only | 877 | transcript 397, shell 168, session 103; the check doesn't know the parity ruling that v1's kit is the look |
| one-owner | 239 | spread across domains (duplicate names and dictionaries) |
| one-home-per-datum | 81 | transcript 51 |
| size | 73 | composer 44: `harness-config-store.ts` is 346 lines, with a 258-line `createHarnessConfigStore` and a 184-line `createHarnessHydrator` |
| no-swallowed-errors | 56 | transcript 17, composer 13, session 11, auth 9 |
| domain-boundaries | 36 | composer 11, rail 7, shell 6, session 6 |
| budget | 8 parts over | composer 11.3k (budget 5.5k); `src/ui` plus transcript 23.7k (budget 20k) |
| no-polling | 4 | see Performant |

These pass: typecheck, adapter-boundary, no-directory-identity, access-boundary, protected-areas, e2e-hygiene.

**The biggest problem: two UI kits.**
- Ported v1 components import `@opencode-ai/ui`: 72 files import its Button, 43 its dialog context, 39 its toast.
- v2's own `src/ui` still supplies a second Button (21 importers), `useDialog` (18) and `showToast` (13).
- The plan's goal 1 ("one UI kit, inside the app") conflicts with the owner's ruling ("v1's look is the kit").
- **The resolution that meets both:** one kit that renders v1's look and lives in the app.
  - At the swap, move the v1 kit components v2 actually uses into `src/ui`, delete v2's duplicates, and drop both kit dependencies.
  - Until then, `packages/ui` can't change, because today's app shares it.

**Repo gates** (checked 23:20):
- **`bun run test:architecture-ratchets`: the retirement and product-boundary steps pass.**
  - The transcript seed no longer names retired contracts.
  - The local-server closure ceiling rose to exactly 73/30 source and 102/31 runtime, for the daemon's live plugins; `verify:closure` passes in full.
- **The helpers step fails, with 4,390 findings.**
  - About 3,200 are in `src/legacy`, and nearly all the rest pair v2's copies with v1's originals.
  - They clear when `src/legacy` is deleted and v1 goes at the swap.
  - The 8 real ones in live v2, local `isRecord` copies, are fixed (3e2ea6eb3a).

**One kit, progress:** toasts (876dad469b) and Tooltip (54257ea3ec) are now the kit's, with v2's copies deleted. Dialog and Button are next, one surface per commit.

### 4. Less LOC

Measured as tracked `.ts/.tsx/.js/.mjs`, without tests, stories or locales (the plan's measure):

| | v1 today | v2 now | Target at the swap |
| --- | --- | --- | --- |
| App production code | 175.6k, plus a 35.7k perf harness | 86.4k | ≤ 94k for app and kit together |
| Kit packages the app imports | `ui` 15.7k, `session-ui` 20.8k | the same two packages | inside the 94k |
| Unit tests | 155.2k | 0 | 0 |
| e2e | 56.8k | 6.2k | ≤ 16k |
| First-party plugins | inside the app | 14 lines (Tasks and Pages stubs) | ≤ 7k |
| `src/legacy`: v1's copy, the porting source, not built | — | 141.3k | 0, deleted when nothing is left to port |

**The honest projection:**
- The budget check counts 77.2k of 94k, but its part table leaves out the two kit packages.
- App plus kit is about 123k today, and the unported surfaces still have to fit: settings sections, onboarding, Marketplace, Tasks, Pages.
- Reaching 94k needs two things:
  - the one-kit move, which brings in only the kit components v2 uses;
  - the composer shrunk back toward its 5.5k row.

## Where things are

| Ref | State |
| --- | --- |
| `feat/app-v2` in `~/test/opencode-app-v2` | The integration branch; tip in `git log -1 feat/app-v2`. Base is dev `37563dc802`, and dev hasn't moved since. 468 commits, 240 of them non-merge. **Not pushed.** |
| Lanes | `~/test/opencode-app-v2-lanes/<lane>` on `v2/<lane>`. See [Lanes at the stop](#lanes-at-the-stop). |
| Unmerged WIP | Five lanes stopped with uncommitted work. It's saved as WIP commits on their own branches, unreviewed and unmerged:<br>• `v2/adapter` `f1439bf342`: subagent wire<br>• `v2/checks` `c87e2ebc5e`: check proofs<br>• `v2/live-plugins` `23888d6e0a`: the `claxedo plugin` CLI<br>• `v2/plugins` `4fe40a57d6`: flows 20, 28 and 29; flow 29 is obsolete, since the owner deleted the Codex theme plugin<br>• `v2/server-projects` `57667c45d6`: D1 project store and migration 0042 |
| Outside the v2 package | 73 files: the local projects route (server-core, local-server), plugin-api and plugin-build, desktop `dev:v2`, and the `plugins/tasks` and `plugins/pages` stubs. |
| `packages/claxedo-app` (v1) | Untouched. |

**Test servers, all run from `~/test/opencode-app-v2`:**

```sh
# v2 on 4480: Vite dev, so merges into feat/app-v2 show up live
cd packages/claxedo-app-v2 && CLAXEDO_DEV_PROXY_TARGET=http://127.0.0.1:2598 PORT=4480 bun run dev
# v1 on 4481
cd packages/claxedo-app && VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:2598 CLAXEDO_DEV_PROXY_TARGET=http://127.0.0.1:2598 PORT=4481 bun run dev
# daemon on 2598 with the pinned Pi 0.85.1 (the runtime refuses Homebrew's 0.87.1)
cd packages/claxedo-server && PI_EXECUTABLE=$PWD/../agent-sdk-runtime/.artifacts/pi/node_modules/.bin/pi CLAXEDO_SERVER_PORT=2598 bun run start
```

- **The daemon on 2598 holds the owner's real data.** Agents may navigate and screenshot there, nothing else.
- **Flows run their own stacks** on lane port ranges: `CLAXEDO_E2E_PORT_RANGE=<a>-<b> bun run e2e -- --app=v1|v2`.
- **Restart the daemon after any server change.** "/welcome while projects exist" was an old daemon that didn't send `available`, so the app's guard dropped every project.

## Owner-reported bugs

Updated 21:40, after the owner switched accounts and the lanes resumed.

| The owner's report | Lane | State |
| --- | --- | --- |
| The landing says "Nothing is open" | session-screen | **Fixed** (b729548e87). `/w/<ws>/session` opens the workspace's one draft, and the landing skips unavailable projects. Verified in a fresh browser on 4480. |
| Missing projects sort first and aren't dimmed | projects-app | **Fixed** (96ce7ab098, cb45ca5ae6). v1's order is by project id. A project is available while a folder exists or a cloud sandbox is ready. The daemon was restarted and verified. |
| "terminal only appears in tab not in left sidebar" | shell | **Fixed** (6c6df50e56). One `session \| terminal` row list in `rail/model.ts`. Flow 13 passes on v1 and v2. |
| Account card; Usage opens Settings → Usage; sign in and out | shell | **Done** (b763917e60). The org switch waits for org routes in the adapter and something in v2 that consumes the choice. |
| "no need of separate setting icon, keep usage icon beside accounts menu" (21:10) | shell | **Done** (142bb781ba). |
| "skipping/stop button clicking on question dock, make it stuck" | session-screen | **Partly fixed** (4bf6411e77): a failed reply no longer freezes the dock. Still being checked: the dock must disappear when the harness closes the question after Stop. |
| Todo dock goes away when done; stays collapsed across a reload | session-screen | **Fixed** (54fc8c7c27). This deviates from v1 and is recorded in DECISIONS. |
| Contrast sliders show only for Codex | main | **Fixed** (94b91105c8). Verified headless. |
| "subagents are going to top for no reason" | transcript | In progress. `ambientSubagents()` claims chips that belong to a turn. |
| Subagents open as a workspace-panel tab; same-page logic removed | transcript | In progress, after the attribution fix. Flow 09. |
| Closing a terminal from the rail leaves it in the compact tabs | shell | In progress. The fix is one owner for the terminal list. |
| Clicking a file in the Files navigator freezes for seconds; toggling the navigator back freezes the app | tools (resumed for this only) | In progress. Traced with long-task timings, and fixed at the cause. |
| The composer floats over a maximized panel | session-screen | Queued. |

**Found by the flows with no owner running:** v2's `/login` shows only "Continue", with no email form (00-signed-smoke). The auth screens belong to the stopped settings-access lane.

## Former owner questions, closed 2026-09-25 12:10

The owner said none of these needs them. Each is closed as follows:
- **Teams inside an org:** v2 keeps v1's Organization section with its sign-in and error states. Team management isn't built, as the plan recommends; on a local build v1 shows only "Bearer token is required" anyway.
- **Machines remote access:** not ported. v1's local build binds no `machineRemoteAccess` port either, so parity holds.
- **`/welcome` and Settings Back:** kept (owner, 02:40).
- **The daemon restart** that picks up the runtime fixes: done. The daemon on 2598 has restarted several times today.
- **Closing a terminal:** as recorded in DECISIONS 18:25. A terminal the server lost is recreated from its history, as v1 does (TOOL-129).
- **The contrast formula:** the one derived from the Codex bundle stays. At default contrast, v2 computes v1's exact values (settings-access, 38fb4ec14a).
- **The todo dock when everything is done:** it goes away, as the owner asked at 20:28.

## Deferred by the owner

At 19:08 the owner said: finish in-progress work; start no new work.

- **Settings sections** in v2's settings style: General, Models, Terminals, Machines, Orgs & Teams, Presets.
- **v1's onboarding.** Flow 01 fails on v2 until it lands.
- **Marketplace, Tasks and Pages:** the extras inventory has 103 rows missing.
- **The composer's Environment, Workspace and Branch chips** (PROJ-078..080), with worktree creation on first send. Also PROJ-074, the inline Connect GitHub, unless projects-app landed it.
- **Session screen:**
  - the floating composer over a maximized panel;
  - the session-edge "Open changes / Open files" strip, which flow 14 waits on.
- **Shell:** the phone surfaces (SHELL-951..).
- **Panel and palette:**
  - recent files in the palette: v1 shows the session's file tabs, active first, deduped, so the panel needs a `filePaths()` accessor that owns that order;
  - the panel's "+" → File;
  - v1's `review.toggle` (⌘⇧R).
- **Editing files with Pierre.** The owner asked for it, and no server write route exists yet.
- **Flows not yet written:** 17–25, 28, 32, 34–36. The signed flows need the self-hosted Node signed fixture.
- **Stopped lanes with WIP:** live plugins, hosted projects on D1, the checks lane.

## Plan deviations taken during the night

- **Tasks is an app domain (`src/tasks`), not the `plugins/tasks` plugin.** Moving it into the plugin needs three host changes:
  - a `tab` flag (and icon) on plugin pages;
  - `sessions.open` taking a `workspaceId`;
  - the rail's `/tasks` row claimed by the plugin.
  That's about 2–3 hours of rework with no user benefit now.
- **Over budget, awaiting a scope review, not squeezed:**
  - Marketplace: 2,384 lines against 1,800.
  - Tasks: 3,514 lines plus 1,343 of v1 CSS, against a plugin budget of 2,500.
- **Hidden session, draft and page panes unmount**; terminals stay mounted (fd195fe7be). Measured: +8.5 ms per return to a visited session, ~12 MiB less JS heap with 8 sessions open.

## Performance findings to apply at the swap

- **The kit's `ScrollView` (`packages/ui/src/components/scroll-view.tsx:225`, `updateThumb`)** reads `scrollTop`, `scrollHeight` and `clientHeight` every frame while scrolling. That forces the layout the virtualizer just dirtied: about 0.8 ms per wheel event, 49 ms of 350 ms busy while wheel-scrolling an 8 MiB session.
  - The fix: cache the heights from ResizeObserver entries and read only `scrollTop` per frame.
  - It can't land before the swap, because `packages/ui` is shared with today's app. Apply it when the used kit components move into the app.

- **The kit's `ScrollView` unmounts its thumb (`packages/ui/src/components/scroll-view.tsx:451`, `<Show when={showThumb()}>`).**
  - The thumb is the viewport's last sibling, so the viewport's `:last-child` flips whenever overflow starts or stops, for example on a short session's first long reply.
  - The markdown rules `.ui-markdown>[data-markdown-block]:first-child>*:first-child` and `…:last-child>*:last-child` make the `:first-child`/`:last-child` invalidation "whole subtree". So the whole mounted transcript restyles once per flip.
  - The fix: keep the thumb mounted with `hidden`. v2's own `ScrollThumb` got exactly that on feat e02a7e8cdd, and collapse-all's restyle fell from 1,324 to 673 elements.

- **The kit's select listbox sibling rule (`packages/ui/src/components/select.css`, `.ui-select-select-content-list > *:not([role="presentation"]) + *:not([role="presentation"])`)** has a universal subject. Blink flags every parent it tests as affected by `+` rules, so a sibling change anywhere restyles following siblings with their subtrees.
  - Measured on the file palette's close (files-perf, 2026-09-25): with the markdown edge rules removed, the close restyles 755 elements with this rule as it is, and 260 with it written `> [role="option"] + [role="option"]`, the only children it spaces (Kobalte renders options as `role="option"` and section headings as `role="presentation"`).
  - v2 can't override it away, because the rule stays in the sheet and keeps flagging. Apply the rewrite when `select.css` moves into the app. The markdown edge rules belong to `lane-transcript-perf`.

- **The kit's Tailwind entry (`packages/ui/src/styles/tailwind/index.css`) scans every consumer's source** (`claxedo-app/src`, `claxedo-desktop/src/renderer`, `session-ui/src`), so each app ships the others' utilities.
  - v2 already excludes v1 and the desktop app with `@source not` in `shell/styles/index.css`, and scans only its own `src`, the kit, and `session-ui/src` without tests, stories and the lab fixture: 36,390 → 21,277 candidates. None of the 239 dropped classes appears in v2's bundle.
  - Two of v1's utilities, `group-data-[expanded]:opacity-100` and `group-data-[expanded=true]/section:rotate-90`, compile to a universal descendant selector. When shipped, each open or close of a menu or dialog restyled about 560 elements.
  - At the swap, the kit's entry should scan only the kit. Each app's entry then names its own sources.

- **The kit's `List` (`packages/ui/src/components/list.tsx`) renders a new group object per filter result**, so its outer `For` rebuilds every group and row on each keystroke. It also compares `props.key(item) === active()` in every row.
  - v2 renders its own twin (`src/ui/list/`) through `@/ui`: groups keyed by category, rows diffed by reference, `data-active` and `data-selected` through `createSelector`. File palette "markdown": 18,458 → 7,198 computations. Command palette "settings": 29,996 → 9,026. Model picker "gpt": 75,069 → 1,892.
  - At the swap, the twin replaces the kit's `List`.

- **The kit's sprite hosts (`packages/ui/src/components/inline-svg-sprite.ts`, `ensureSvgSpriteHost`) are `aria-hidden` children of `<body>`.** Kobalte's hide-outside pass skips an element that is already `aria-hidden` without recording it, and walks into it. So every menu, dialog or popover writes `aria-hidden` on each `<symbol>`: 494–500 writes to open the account menu and 168 to close it.
  - v2 mounts its own shelf (`src/ui/sprite-shelf.ts`): one un-hidden `display: contents` element holding every known host. The kit finds its host by id, so opening the account menu writes 12 and closing it writes 3.
  - At the swap, `ensureSvgSpriteHost` should create hosts inside the shelf. Then a sprite id missing from `SPRITE_HOST_IDS` can't land back in `<body>`.

- **Chevron rules keyed on `[data-slot]` or `svg` under `[data-expanded]`** make every `data-expanded` change invalidate every element with a `data-slot` attribute, or every `svg`, below the element that changed. Examples: session-ui's `session-review.css` and `session-turn.css` diff chevrons, and the kit's `select-v2.css` chevron.
  - v2's transcript copies select the chevron by class (`ui-session-review-diff-chevron`, `ui-session-turn-diff-chevron`) in v2's own markup, and v2 loads neither session-ui's sheets nor `select-v2.css`.
  - Toggling `data-expanded` on the palette's dialog restyled 618 elements before and restyles 10 now.
  - At the swap, apply the same class keys to session-ui and select-v2 if they survive.

## Streaming at 60 Hz (exp-stream, 2026-09-25)

**Scenario:** a session with 22 earlier turns streams a 12k-character reply (headings, lists, 5 code fences, a table, Mermaid, 4 tool parts): 1,540 deltas, 8 characters every 25 ms, measured on production builds. At 1x every build holds 60 Hz; the differences show up in per-delta latency, CPU and memory, and at 4x throttle in missed frames.

| | v1 | v2 on feat | v2 with every fix below |
|---|---|---|---|
| Delta to paint, p50 (1x) | 5.8 ms | 17.3 ms | 8.4 ms |
| Delta to paint, p50 (4x) | 14.8 ms | 22.1 ms | 11.8 ms |
| Frames over 16.7 ms (4x) | 53 | 48–98 | 15 |
| Main thread busy (4x) | 71% | 54% | 36–40% |
| Heap after GC | 42.8 MiB | 37.0 MiB | 16.2 MiB |
| DOM nodes after GC | 48.7k | 48.6k | 3.7k |

**The design causes, and their fixes:**
- **A. Two animation-frame buffers in series.** Every delta waited one extra frame. It now commits in the event intake's frame, which halves latency (17.3 → 8.4 ms). Merged into feat as b6597411cd.
- **B2. Every delta re-lexed the whole message**, which is quadratic: 32.5 ms per delta at 37k characters. The fix re-lexes only the open block and gets it to 0.68 ms.
- **B1. The open block was parsed and sanitized twice per delta.** The fix renders it once while streaming.
- **C. Table copy and view buttons were built on a throwaway tree on every delta and never disposed.** That leak exists in v1 too, at about 20 MiB and 45k nodes per long reply. The fix creates the controls once on the committed DOM.
- **D. Every delta rebuilt all of the turn's timeline rows**, because the rows tracked the text rather than the part's shape. 756–920 → 23–27 ms.
- **E. Follow-at-end had two owners**: anchorBottom and the virtualizer's anchor. The fix removes one. It's neutral for performance and simpler.
- **F. DOMPurify re-read its config on every call** (about 27% of sanitize). The fix configures it once.

**Status:**
- B–F change `src/transcript` and the timeline, which AGENTS.md reserves for an owner-signed, corpus-proven slice.
- They're on **`v2/stream-slice`**, ready for the owner. Each fix is its own commit with its corpus case and a red run. E is dropped: it saved no CPU.
- The corpus can now replay a live turn and compare it with today's app at every hold. Until now no case covered the streaming renderer.
- **Checks on the tip:** the whole corpus plus flows 03, 04, 09 and 11, on web and phone, 37 passed.
- **Write-up:** `docs/app-v2-stream-slice.md` (commit by commit, before/after, the case, the red run).
- **Merged:** the owner signed it off at 11:50, and it's on feat as e9cd0024be.

**Measured on the slice** (feat → slice, v1 in brackets, heap after a forced GC):

| | 1x | 4x |
|---|---|---|
| Delta to paint, p50 | 9.0–9.2 → 8.2–8.5 ms [5.7] | 13.9–14.1 → 10.9–11.5 ms [13.7] |
| Frames over 16.7 ms | 0–2 → 0 [0] | 21–31 → 13–14 [16] |
| Main thread busy | 13.1–14.1% → 10.3–11.2% [17.7–18.5%] | 45.6–50.4% → 28.0–35.2% [66%] |
| Heap | 37.5 → 16.7 MiB [43] | 37.5 → 16.9 MiB [43] |
| DOM nodes | 48.6k → 3.7k [48.7k] | 48.6k → 3.7k [48.8k] |

**Open after the slice:**
- **Latency at 1x:** the median delta-to-paint at 1x is still 8.2–8.5 ms against v1's 5.7, cause not measured.
- **Follow-at-end offset:** v2 ends 72–76 px above v1's scrollTop on a long streamed reply, with or without E. That's a parity difference, and the timeline owns it.
- **v1 bugs v2 reproduces** (the baselines record them):
  - an early reference link stays unresolved after a late definition;
  - a `$$` fence split across deltas sometimes leaves a stray paragraph.
- **v1 dropping the stream:** twice, a v1 run at 4x stopped following the stream.

**Remaining long frames:**
- mounting a new tool card: 15–25 ms at 1x;
- the first Mermaid render;
- the settle read at turn end: 93 ms at 4x.

## Server gaps found by the parity work

- **Harness health is pull-only.** The composer's health peek ("The agent stopped responding / Check again") polls every 20 s during a turn: v1 reads `/api/wr/health`, v2 reads `GET /api/claxedo/agent-config/harness?workspaceId=…&sessionId=…` (`harnessHealth.status`, `connectionState`). It is the one no-polling finding left, because no event carries `degraded` or `harness_process_lost`. Publish a health change when a driver records a process error, for example a `harness.health` event, and the peek's timer can go.
- **The provider catalog route always answers with the whole catalog.** `GET /api/claxedo/agent-config/providers?nativeHarness=opencode` (`claxedo-local-server/src/agent-config/routes/provider-routes.ts`) returns models.dev's full list, 2,325,904 bytes and 1.6 s cold on the owner's machine, and ignores the `provider` parameter both apps send for one provider's detail, so a detail read costs the same as the index. v2 now reads the catalog once per harness through one cached query (`server.queries.providerCatalogs`), and skips the detail read whenever the index already holds a provider's models, as it always does here. The remaining 1.6 s first read needs the server: honor `provider` to return that provider alone, and add a summary form (connected providers with their models, the rest with ids and names) for the pickers.
- **Session config carries no model display name.** An existing session's config names its model by id only, so v2's closed picker labels it from a per-browser display-name cache (`composer/harness/model-names.ts`) rather than read the whole provider catalog at mount. With the name in the session config the cache can go.
- **A new draft's harness options cold-start a process.** `GET /api/claxedo/agent-config/harness/options?nativeHarness=pi` starts `pi --no-session` on every read: 2.4–9.9 s under load, while Send shows "Loading models…". v1 behaves identically. Fix it server-side: cache the options per harness, or keep one warm process.
- **Fixed in the runtime today (take effect after a daemon restart or rebuild):**
  - a stopped turn publishes the questions and permissions it settles (2b7f71a178);
  - a harness without Goals reports them as not implemented, so its sessions open (09caeef9dd).
- **No read across workspaces.** Boot makes 3 reads per reachable placement (`/session/status`, `/permission`, `/question`, which is v1's set since 8c551d4757) on top of the session-list page. v1 reads only for workspaces with rows on screen. A single cross-workspace status read on the server would make boot one request.
- **Left open by the adapter lane:**
  - `SessionRow.harness` from `config.harness.id`;
  - the "Untitled session" fallback;
  - creating a worktree doesn't invalidate the root git queries;
  - the scripted ACP subagent step sends no tool call, so no live check exercises `toolCallEdges`;
  - adapter probes need `bun run pi:install` in agent-sdk-runtime first (Playwright's global setup does it, the probe doesn't).

- **A cancelled turn is recorded as completed (runtime; both apps).** The harnesses signal a cancelled turn as `session-status idle` without `finish`:
  - ACP `translateStopReason("cancelled")` (`agent-event-runtime/src/harnesses/acp/translate-session-update.ts`);
  - Codex `cancelled`/`interrupted`;
  - Cursor `cancelled`.

  `outcomeFromPayload` (`agent-sdk-runtime/src/runtime/turn-outcome.ts`) maps that idle to `{status: "completed"}`, and the turn's own producer finalizes with it. `finalizeCancelled` (`runtime/recovery.ts`) then finds the turn already finished and doesn't write its `{status: "cancelled", reason: "abort"}`. So neither app ever shows "Interrupted" after a Stop. Proven on v1 with the scripted ACP agent answering `cancelled` (lane-transcript-3). The corpus case `interrupted-turn` is in progress on `v2/harness`.
  - **Fix:** a terminal cancelled event in the runtime vocabulary. It belongs in the harness rebuild (`docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md`).
  - Parity holds meanwhile, since v1 has the same defect.

- **A v1 edge case, kept for parity:** a Mermaid diagram that renders small, then grows past the large-diagram threshold while streaming, keeps its full-screen button over the "Render diagram" placeholder. The deferred path's `.remove()` selects a slot nothing writes, in v1's session-ui too. The fix after the swap is `clearRichControls(wrapper)` in that branch, as the failure path already does.

- **Carry into the harness rebuild (`feat/harness-v2`):** feat/app-v2 changed the runtime in ways that rebuild must keep:
  - the explicit cancelled terminal (476c6a5acd): Stop records `cancelled`, and "Interrupted" shows;
  - `reportHealthChanged` and the `harness.health` frame on `wr/events` (0d73f11527), which the composer's health peek depends on;
  - pi's `unsettled-launches` owner (308242675e): an unsettled probe never marks pi unavailable;
  - the pi options cache (70794a7c9a);
  - the kill(-1) fix ported from harness-v2 (652e6f6d97).

## Deletion candidates

**The dead revert path.** No harness declares `revert`, v2 passes no `actions` to MessageTimeline, and v1 never renders these (DECISIONS 23:55). Delete the whole list together, or bring it back together with a harness that declares revert. Line numbers are as of 27781bb17e.
- `src/transcript/message-part.tsx`:
  - 205-211: `UserActions.revert` and `fork`. `openAttachment` in the same type is live and stays.
  - 1213-1224: the `revert()` handler.
  - 1329-1344: the "Revert message" button.
- `src/session/view/timeline/message-timeline.tsx`: 1185, 1289-1296 (`undoTurn`), 1303.
- `src/session/view/timeline/message-timeline-turn-rows.tsx`: 87, 99-105 and 119-133 (the "Undo" button).
- `src/session/view/timeline/message-timeline-props.ts:9` and `timeline-user-message.tsx:10,16`: the `actions` prop.
- The i18n keys `ui.message.revertMessage` and `transcript.message.revertMessage`. Check dynamic key readers first.

**`src/legacy`,** 153k lines: v1's copy, the porting source. Delete it when nothing is left to port.

## Next steps, in order

0. **Plugins by asking any session** (DECISIONS "Owner, 2026-09-25 12:55"): authoring uses four Claxedo MCP tools (`app_plugin_create`, `app_plugin_add`, `app_plugin_check`, `app_plugin_guide`), and the guide reaches every harness. The plugin CLI is deleted. The follow-up design, where plugin UI is A2UI JSON drawn with the app's own components and plugin logic runs sandboxed on every platform, is `docs/plans/2026-09-25-001-app-plugins-declarative-ui-plan.md`. For now app plugins stay as they are: sandboxed frame on the web, in-app on desktop with the user warned.
1. **Owner:** test 4480 against 4481. Each difference becomes an inventory row or a DECISIONS line.
2. **Owner:** sign off `v2/stream-slice`, exp-stream's five transcript fixes (see [Streaming at 60 Hz](#streaming-at-60-hz-exp-stream-2026-09-25)). Then merge it and run the whole corpus.
3. **The seven panel rows that go to v1:**
   - exp-scroll found the cause: `src/review/diff-content.ts` `request()` writes a new file list on every CodeView emit and scroll frame, so the 24 diff queries and the Review list rebuild each time. Making it a no-op for an unchanged list takes collapse-all from 32.0 to 23.2 ms busy JS per click (v1 27.3), and idle CPU with Review open from 8.8% to 1.4% (v1 3.6%).
   - v1 doesn't keep visited file tabs mounted either: retaining them blanks Pierre's viewer on reveal. The one tab gap is Review's scroll restoration, which lane-tools-3 is porting.
   - Then lane-bench-3 reruns the workspace-panel lane.
4. **Start (≤ 1.1 s) and idle memory (≤ 700 MiB):** exp-idle's findings, applied through the owning lanes.
5. **Checks to zero:** transcript and timeline comments and names first, with comments triaged into corpus cases or README lines; then the remaining domains. Split files by responsibility; never squeeze.
6. **Move the transcript's module caches and singletons into provider-owned stores**, as their own corpus-proven slice with a bench rerun. Until then they're named exceptions in one-home-per-datum.
7. **Refresh the inventory status** with `bun run e2e:parity`.
8. **Delete `src/legacy`** once nothing live imports it.
9. **Make the flows robust:** 20 local runs per spec, 3 CI repeats, and the coverage map against v1's 58 specs.
10. **Rerun the publication benchmark** on the final tip. Then P6 "Ready for you", the owner's test, and the swap (plan § P6). Never swap without the owner's approval.

## Lanes at the stop

At 20:30 the owner said to wrap up. Each running lane was given its last items, told to commit each one, report, and stop:

| Lane (agent) | Last items |
| --- | --- |
| shell (`lane-shell-4`) | terminals in the rail, then the account card |
| session-screen (`lane-session-screen-3`) | the draft route, the question dock, the todo dock |
| transcript (`lane-transcript-3`) | subagents in their turn, the subagent panel tab, the ascending-messageId default in `e2e/harness/api.ts` (flow 11's flake cause), the ratchet fixture |
| projects-app (`lane-projects-app-3`) | project order and dimming; PROJ-074 only if small |
| harness (`lane-harness-3`) | commit, send the v2 run table, stop |

Every other lane is stopped: adapter, session-data, kit, tools, settings-access, plugins, checks, server-projects, live-plugins, bench.

**How a lane's work was merged:** `integrate.sh <lane>`, run in the integration worktree.
1. `git merge --no-ff v2/<lane>`; a conflict aborts it.
2. `bun install` if a manifest or lockfile changed.
3. `typecheck`, `typecheck:e2e` and `build` in `packages/claxedo-app-v2`. Any failure undoes the merge with `reset --hard` to the pre-merge commit.
4. A list of files the merge changed outside the lane's folders. That list caught one lane's merge silently reverting another lane's change.

## Lessons from this run

- **Usage is the bottleneck, not parallelism.**
  - 16 concurrent Fable agents used the whole 5-hour window in about 40 minutes.
  - 6 to 10 Opus agents used a window in about 3.5 hours.
  - Run at most 5 lanes.
- **Messaging a stopped agent resumes it.** Keep the list of names that may be messaged exact.
- **Never kill processes by name or pattern.** One lane took down the owner's test servers that way, and another lane quit Chrome.
- **Don't stop a background task unless you started it.** The task list shows teammates' tasks too.
- **Restart the daemon after server changes.** The app guards wire shapes strictly, so an old daemon empties lists instead of erroring.
- **Merges silently revert.** Read the outside-folders report after every merge.
- **Green is a claim.** A flow that passes on v2 alone proves nothing about parity. Every baseline flow is written v1-first and must pass on v1 before it judges v2. It branches only for an approved deviation, titled with its DECISIONS entry.
