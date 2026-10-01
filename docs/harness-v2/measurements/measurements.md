# P0.7 measurement manifest — the file lists behind every plan number

Plan: `docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md`, measured on `dev` at `37563dc802`.
Today measured on `feat/harness-v2` at `e90ea3215d` (worktree `/Users/yashvardhansingh/test/opencode-harness`, clean at measurement time).

**Counting rules.** "Production lines" = Appendix C rule: `find <dir> -name '*.ts' ! -name '*.test.ts' ! -path '*/test-utils/*' ! -path '*/test-support/*' ! -name 'test-temp-dir.ts' | xargs cat | wc -l`. "Test lines" = the same tree filtered to `*.test.ts` plus `*/test-utils/*`, `*/test-support/*`, `test-temp-dir.ts`. "Translator moved size" = `grep -vcE '^\s*(//|\*|/\*|\*/)'` (comments removed, blank lines kept). Importer counts use resolved relative specifiers plus the package's own subpath exports (a script in `_importers.py`); "production importers" excludes `*.test.*` and `*.vitest.*` unless noted.

**Dev values** were re-run against a `git archive dev` snapshot (`_devtree/`); each entry also gives the plain worktree command, which reproduces the plan number only on a `dev` checkout. **Today values** run on the `feat/harness-v2` worktree.

`measure.sh` re-runs every command and prints `dev.<name> value` / `today.<name> value` lines (dev via `_devtree/`).

## 1. Package totals

### M1 — "49.7k production lines" (§Where the lines go; App. C row 1)
- Plan: "29,684 + 15,512 + 3,216 + 1,275 = 49,687" across four packages: `agent-sdk-runtime`, `agent-event-runtime`, `agent-runtime-contract`, `opencode-server-adapter`.
- Command (per package): `find packages/<p>/src -name '*.ts' ! -name '*.test.ts' ! -path '*/test-utils/*' ! -path '*/test-support/*' ! -name 'test-temp-dir.ts' | xargs cat | wc -l`
- Lists: [dev](lists/devprod-agent-sdk-runtime.txt) vs [today](lists/prod-agent-sdk-runtime-today.txt) (and same pattern for the other three).
- Dev re-measure: 29,684 / 15,512 / 3,216 / 1,275 = 49,687 — **exact match**.
- Today (re-measured): 26,632 / 14,444 / 3,466 / 1,277 = 45,819 — **mismatch, −3,868 vs the dev baseline**. Causes: process ownership moved out (−2,222, now `packages/process-ownership`, 2,255 lines), the committed Codex protocol deleted in favour of build-time generation (−6,713 committed; 5,645 now generated on disk), plus branch fixes. `agent-runtime-contract` **grew** +250 to 3,466.

### M2 — "42.8k lines of unit tests" (Part 1 §2, §Why fewer tests; App. C "Test lines")
- Plan: 42,765; "about 1,470 cases" in the four packages.
- Command: same `find` with the test patterns inverted (`-name '*.test.ts' -o -path '*/test-utils/*' -o -path '*/test-support/*' -o -name 'test-temp-dir.ts'`) `| xargs cat | wc -l`.
- Dev: 42,764 — match within 1 line (trailing-newline counting). Today: 40,710.

### M3 — "184 files, ~1,470 cases, ~4,255 assertions" (§Tests; App. C)
- Command: `find packages/{4 pkgs}/src -name '*.test.ts'`; cases `grep -c 'test('`, assertions `grep -c 'expect('`.
- Dev: 184 files ✓; 4,255 assertions ✓ exact; cases 1,445 by `test(` or 1,476 including `it(` — plan's "~1,470" sits between (pattern-dependent).
- Today: 178 files, 1,368 `test(`-cases (1,399 with `it(`), 4,003 assertions. Lists: `lists/testish-*-today.txt`, `lists/devtest-*.txt`.

## 2. Moved unchanged

### M4 — Process ownership "2,222 lines" (§How the work runs, §Moved unchanged, App. C)
- Plan: `launch` 1,424 + `process-observer` 189 + `process-lifecycle` 418 + `windows-process` 120 + `spawn-env` 71 = 2,222.
- Command: `wc -l` on the 13 files in [lists/dev-process-ownership.txt](lists/dev-process-ownership.txt).
- Dev: 1,424+189+418+120+71 = 2,222 — **exact**. (The last three live under `src/harnesses/shared/`, a fact Appendix C's own command would have needed.)
- Today: same 13 files now in `packages/process-ownership/src` ([list](lists/today-process-ownership.txt)), 2,255 — **mismatch +33**: `launch/identity.ts` 277→304 and `launch/retirement.ts` 219→225, the T-10 UTC/pid fix on this branch.

### M5 — Runtime host "3,604" (§Scope, §Moved unchanged, App. C)
- Plan: `runtime.ts` 829 + `runtime/*` 2,775.
- Command: `find packages/agent-sdk-runtime/src/runtime -name '*.ts' ! -name '*.test.ts'` + `wc -l src/runtime.ts` — [list](lists/dev-runtime-host.txt).
- Dev: 829 + 2,775 = 3,604 — **exact**.
- Today: 816 + 2,819 = 3,635 — **mismatch +31** (host still in `agent-sdk-runtime`; P1.1 moved only `sse.ts`, per the plan's own Progress note; the rest moves at P3).

### M6 — Projection "3,222" (§Scope, App. C)
- Plan: `client-presentation` 2,041 + `compat-events` 471 + `turn-projection`+`child-event-routing` 467 + `sse` 243.
- Command: `wc -l` over [lists/dev-projection.txt](lists/dev-projection.txt); `client-presentation` = `agent-event-runtime/src/projections/client-presentation/`.
- Dev: measured client-presentation **2,000** (prod rule), so total **3,181**, not 3,222 — **mismatch −41 on `dev` itself** (the plan's 2,041 does not reproduce; including tests gives 3,291, so it's not a test-inclusion issue). 2,041 also does not match `wc -l` on the dir with fixtures — plan likely counted a pre-move or slightly different file set.
- Today: same files, `sse.ts` now at `session-core/src/projection/sse.ts` ([list](lists/today-projection.txt)) — still 3,181.

### M7 — Event contracts "458" (§Scope, §Moved unchanged)
- Command: `find packages/agent-event-runtime/src/contracts -name '*.ts' ! -name '*.test.ts' | xargs wc -l`
- Dev 458 — **exact**; today 458, still unmoved (P4 moves them to `agent-runtime-contract`).

### M8 — Moved translators "~5.2k" (§Moved unchanged, App. C)
- Plan: Claude 1,412 + `partial-json.ts` 98; Codex 1,313; Cursor 691; ACP 1,538; Pi 192.
- Command: `grep -vcE '^\s*(//|\*|/\*|\*/)'` on [lists/dev-translators.txt](lists/dev-translators.txt). Note the rule is selective: only `adapter.ts` (+`partial-json.ts` for Claude) per harness, except ACP where all 8 files count.
- Dev: every figure exact; total 5,244 ≈ 5.2k. Today: identical values ([list](lists/today-translators.txt)); not yet moved to `src/transports/`.

### M9 — Shared translator code "552" (§Translators, App. C)
- Plan: `core/*` 241 + `value.ts` 69 + `host-subagent.ts`/`tool-attachments.ts`/`tool-display.ts` 242.
- Command: `wc -l` over [lists/shared-translator-dev.txt](lists/shared-translator-dev.txt) (agent-event-runtime `src/core/` and `src/harnesses/`).
- Dev: 241+69+121+76+45 = 552 — **exact**. Today: identical; not yet moved to `src/translate/`.

### M10 — ACP restore "~0.4k" (§Moved unchanged)
- Plan: "ACP restoration, quarantine, history reconstruction, `process-retirement.ts`, the restoration half of `acp/recovery.ts`".
- Whole files: `harnesses/acp/process-retirement.ts` 78 + `acp/recovery.ts` 52 = 130 today; the remaining ~270 are functions inside `acp/process.ts` and `acp/turn-runner.ts`, so this is a function-level carve-out, not file-granular — **approximate, not file-reproducible**.

### M11 — "Moved unchanged ~9.0k" (§Where the lines go)
- Plan: 2,222+3,604+3,222 = 9,048 ≈ 9.0k — arithmetic consistent; against measured values it's 2,222+3,604+3,181 = 9,007.

## 3. Deletions

### M12 — Generated Codex protocol "605 files, 6,713 lines" (§Goes, App. C)
- Command: `git ls-tree -r dev --name-only -- packages/agent-event-runtime/src/harnesses/codex/protocol | wc -l`; lines via `xargs cat | wc -l` — [list](lists/codex-protocol-dev.txt).
- Dev: 605 files / 6,713 — **exact**.
- Today: **0 committed files** — b5ff388d93 makes it gitignored, generated at build from Codex 0.133.0. On-disk generated output: 539 files / 5,645 lines ([list](lists/codex-protocol-today-ondisk.txt)). The plan's "Codex 0.156.1 generates 726 files / 115 committed differ / ServerNotification +19" needs running `codex app-server generate-ts`; not re-run here (external tool).
- "~6.9k lines of generated and unimplemented code" = 6,713 + 100 + ~50 = 6,863 ≈ 6.9k — consistent.

### M13 — Harness factories "100" (§Goes)
- Command: `find packages/agent-sdk-runtime/src/harness-factories -name '*.ts' ! -name '*.test.ts' | xargs wc -l` — 6 files / 100 lines on dev, **exact**. Today: **0** — `src/harness-factories/` is already deleted on this branch (only `dist/` artifacts remain).

### M14 — `shell`/`summarize`/`revert`/`unrevert` "~50 + callers" (§Goes)
- Command: the `SupportsRevert`, `SupportsShell`, `SupportsSummarize` blocks, `adapter-contract.ts` on dev (lines ~223–265 ≈ 43 lines) — consistent with ~50. Callers: routes keep 501; **already deleted today** — dev had 17 `Supports*` interfaces, today has 13 (see M21).

### M15 — Test stores "1,860" (§Where the lines go, §Goes)
- Command: `wc -l` `agent-sdk-runtime/src/stores/{memory,sqlite,persisted-rows}.ts` = 995 + 748 + 117 — [list](lists/dev-test-stores.txt). Dev 1,860 — **exact**; today 1,856 (−4).

### M16 — Pi pin set "258" (§Goes)
- `harnesses/pi/executable.ts` 149 + `agent-dir.ts` 26 + `title-extension.ts` 83 = 258 — **exact** on dev and today ([list](lists/dev-pi-pin-set.txt)).

### M17 — Embedded OpenCode engine "3.0k" (§Goes)
- Command: `find packages/workspace-runtime/src/opencode -name '*.ts' ! -name '*.test.ts' | xargs cat | wc -l` — dev 3,006, today **2,997** (−9; `lists/today-embedded-engine.txt`). Matches ~3.0k.

### M18 — `adapters.ts`, `log.ts`, `target.ts`, `paths.ts` "216" + importers 13/15/8/2 (§Goes)
- Lines: 95+76+35+10 = 216 — **exact** ([list](lists/dev-glue-four.txt)); today the same four files total **170** (−46; `adapters.ts`/`log.ts` shrank on the branch).
- Importers: `adapters.ts` 13 via the `@claxedo/agent-sdk-runtime/adapters` subpath export; `log`/`target`/`paths` via `from '../name'` relative imports inside `agent-sdk-runtime/src` = 15/8/2 on dev — all reproduce exactly, and **identical today** (13/15/8/2). Note: the plan's `target` count of 8 includes `test-utils/workspace-directory.ts`; production-only it is 7.

### M19 — Plugin projection adapters "686" (§Goes; "four plugin projection adapters")
- Command: `find packages/claxedo-local-server/src/agent-plugins/runtime/adapters -name '*.ts' ! -name '*.test.ts' | xargs wc -l` — [list](lists/dev-plugin-adapters.txt).
- 7 files / 686 — **exact**. ("Four adapters" = claude 68, codex 252, cursor 126, opencode 77; plus types/native/mcp-projection helpers.) Same today.

### M20 — Drifted `AgentRuntimeEvent` copy "~50" (§Goes)
- The second union definition at `agent-runtime-contract/src/events.ts:149-188` = 40 lines ≈ ~50. Canonical is `agent-event-runtime/src/contracts/agent-runtime-event.ts`. Consistent.

## 4. Operation surface and structure

### M21 — "96 members" (Part 1 §1; App. C)
- Plan: core 20, 26 across 17 `Supports*` add-ons, `AgentGoalResource` 7, `SdkRuntimeDriverHost` 14, `SdkRuntimeTurnInput` 10, `SdkRuntimeDriver` 19.
- Command: member extraction over `adapter-contract.ts` + `harnesses/shared/sdk-runtime-driver.ts` (script `_members.py`).
- Dev: 20/17×26/7/14/10/19 = 96 — **exact**. Today: **92** — 13 `Supports*` interfaces / 22 add-on members; `SupportsRevert`, `SupportsUnrevert`, `SupportsShell`, `SupportsSummarize` (4 members) were deleted on this branch (M14).

### M22 — "Four separate harness lists" (resp. table row 1)
- Command: `grep -rln AGENT_HARNESS_DEFINITIONS|MCP_CAPABLE_AGENTS` + `find -name harness-table.ts -o -name harness-registry.ts` — [list](lists/harness-lists-dev.txt): `agent-runtime-contract/src/harnesses.ts`, `.../harness-table.ts`, `claxedo-server-core/src/agent-plugins/runtime/harness-registry.ts`, `agent-sdk-runtime/src/mcp-resolver.ts`.
- Dev and today: 4 — **exact**.

### M23 — "ACP's three-level class chain" (Part 1 §1)
- `AcpHarnessAdapter` (`acp/index.ts:124`) extends `AcpTurnRunner` (`turn-runner.ts:100`) extends `AcpProcessManager` (`process-manager.ts:80`) — **3 levels, verified** on dev and today.

### M24 — "14 module-level mutable sites" (Part 1 table, principles; App. C)
- Command: `grep -rnE '^(export )?(let|var) [a-zA-Z]|^const [a-zA-Z_]+(: [^=]+)? = new (Map|Set|WeakMap).*\(\)'` over the four packages' `src` (plus `process-ownership` today), excluding `test*` — module-level `let`/`var` plus empty-initialized mutable `Map`/`Set`/`WeakMap`; `new Map([...])` literal tables are constant tables and excluded — [dev](lists/mutable-sites-dev.txt) / [today](lists/mutable-sites-today.txt).
- Exactly **14** on dev and 14 today (`identity.ts`/`launch-gate.ts` sites moved into `process-ownership`, and `acp/state.ts`'s `unserializableContentSeq` is counted on both).

### M25 — "75 Codex notification methods" (resp. table row 8)
- Command: `grep -oE '"method": "[^"]+"' .../protocol/ServerNotification.ts | sort -u | wc -l`.
- Dev: **65** union members — **mismatch** (plan says 75; possibly counted across more union types or a newer generator). Today: generated file has 65 as well (on-disk generated output).

### M26 — "the five `CustomHarnessProvider` hooks" (rows 2, operation map)
- `connection-provider.ts`: `validateConfig`, `immutableIdentity`, `project`, `resolve`, `createAdapter` — **5, verified** dev and today.

### M27 — Pi extension-UI: "five kinds handled, nine defined" (H-5, §Harness specifics, §Changes)
- `pi/driver.ts` question() whitelists `select|confirm|input|editor` and passes `notify` — **5 handled**, rest dropped. Verified dev and today. "Nine" is Pi's RPC surface (docs), not a code count.

### M28 — Fix commits (§Translators table, App. C)
- Command: `git log --format=%s -- <path> | grep -ci fix` (dev; src-scoped for the four-package figure).
- Dev: `agent-event-runtime/src/harnesses` 35/72 ✓; `agent-sdk-runtime/src/harnesses` 117/245 ✓; `launch` 12/28 ✓; four `packages/<p>/src` 197/409 ✓ — **all exact**.
- Today (branch adds commits): event harnesses 35/73, sdk harnesses 118/254, sdk launch 12/29, `process-ownership/src` 3/4, four-pkg src combined 200/424 (per-package sums double-count cross-package commits: 239/538).

## 5. Rebuilt-scope "Today" column and budgets

### M29 — Registry "2,129" (§Rebuilt table)
- Best-effort file set that sums exactly on dev: `connection-provider.ts` 239 + `acp/connection-provider.ts` 159 + `opencode-server-adapter/{provider,config}.ts` 50+297 + `claxedo-server-core` `agent-config/connections.ts` 171 + `session/harness/index.ts` 214 + `credentials/registry.ts` 999 = 2,129 — [list](lists/registry-2129-dev.txt).
- Dev **exact**; today the same files total 2,122 (−7).

### M30 — Capabilities "1,058" (§Rebuilt table)
- File set: `capabilities.ts` 130 + `mcp-resolver.ts` 318 + `sdk-model-options.ts` 156 + `session-model.ts` 58 + `first-party-mcp.ts` 57 + `codex/model-options.ts` 117 + `shared/permission-modes.ts` 222 = 1,058 — [list](lists/capabilities-1058-dev.txt).
- Dev **exact**; today 1,045 (−13).

### M31 — Contract "~2.2k today" (§Rebuilt table)
- Best-effort set ([list](lists/contract-today-2235-dev.txt)): adapter-contract 482 + adapters 95 + connection-provider 239 + acp/connection-provider 159 + harnesses/index 17 + sdk-runtime-adapter 806 + sdk-runtime-driver 213 + sdk-runtime-interactions 224 = 2,235 ≈ 2.2k — consistent within the plan's ±20–25% estimate band; today these files total 2,006 (`adapter-contract.ts` shrank to 348 after the Supports* deletions, `adapters.ts` 49, and `harnesses/index.ts` was deleted).

### M32 — Broker "~5.0k across drivers, host and interactions" (§Rebuilt table)
- Every production file in `agent-sdk-runtime/src` matching permission/question/elicitation/grant/request/subagent/goal/usage/meter/interaction/broker = **4,132** over [36 files](lists/dev-broker-candidates.txt) — below but near "~5.0k"; the remainder is inside bigger driver files, so treat as **approximate**.

### M33 — Drivers "~9.9k today" (§Rebuilt table)
- Raw `src/harnesses/<h>/` production sums on dev: claude 1,733, codex 3,261, cursor 884, acp 6,105, pi 1,412 = 13,395 ([lists](lists/dev-driver-claude.txt) etc.). The plan's ~9.9k is the residual after registry/capabilities/broker/restore buckets carve these same dirs — **partition-dependent; cannot be reproduced file-for-file**. Per-harness "after" targets (0.55/0.8/0.9/1.4/0.45k) are budgets, not measurements.

### M34 — `agent-runtime-contract` "today 3.2k; `recovery.ts` 866 kept" (§Budget table)
- Dev: 3,216 ✓ ~3.2k; `recovery.ts` 866 ✓ exact.
- Today: **3,466** (+250 vs dev) — still under the ≤3.5k gate but with only 34 lines headroom; the 458-line contract move in P4 will not fit as stated.

### M35 — `packages/harness` budgets (≤15.7k merge / ≤13.6k P6; core ≤5.65k)
- Today `packages/harness/src` = 2,361 production lines (38 files, [list](lists/prod-harness-today.txt)) — broker 810, conformance 505, transports 518, contract 506, registry 368, profiles 94, capabilities 65. Still far under the ≤15.7k merge budget.

### M36 — `~31.9k → ~19.2k at merge / ~17.1k after P6` (§Where the lines go)
- Consistency: 49,687 − 6,713 − 100 − ~50 − 1,860 − 9,048 ≈ 31.9k ✓; 15.7k + 3.5k = 19.2k ✓. Arithmetic holds; components verified above.

### M37 — Ratchet ceilings "local server 69/29; server 127/41; desktop main 99/26" (§Conventions)
- Command: `grep -nE 'ceilings: \{[^}]*\}' script/product-boundary/policies/<policy>.ts`.
- Dev: 69/29, 127/41, 99/26 — **exact** (at policy-file lines ~181/128/170 on dev).
- Today: local-server **69/30** (+1 package: `process-ownership` joined the closure — policy line 186 comments "no headroom"), server 127/41, desktop 99/26 unchanged.
- `isolation.buildPackages` (`local-server.ts:206+` today): `process-ownership` already added (line 216) — the P0.1 importer update happened.

### M38 — Importers (§Process ownership, §Scope)
- "21 production files in `agent-sdk-runtime`" = resolved importers of `src/launch/` on dev — **exact** ([list](lists/dev-launch-importers.txt)). Today the specifier text still matches 21 files, but they now resolve to per-harness `launch.ts`/`launch-retention.ts` files — `src/launch/` itself is gone (moved to `process-ownership`).
- "14 importers of `process-observer`" — 14 resolved relative importers ([list](lists/dev-process-observer-importers.txt)) — **exact**. (Repo-wide specifier matches incl. workspace-runtime's own `managed-processes/process-observer` reach 21; the plan's 14 is the in-package count.)
- "13 production files in `claxedo-app` import `@claxedo/agent-event-runtime`" — 15 files match; excluding the two `.vitest.tsx` gives **13, exact** ([dev](lists/app-aer-importers-dev.txt)/[today](lists/app-aer-importers-today.txt)).
- Today: 26 `agent-sdk-runtime` src files import `@claxedo/process-ownership` ([list](lists/today-process-ownership-sdk-importers.txt)).
- Launch-gate packaging sites: all 9 verified on dev; today `launch-gate.ts` lives at `packages/process-ownership/src/launch/` and `verify-package-contents.ts` is under `packages/claxedo-desktop/scripts/`. `workspace-dists.ts` is `packages/harness/e2e/harness/workspace-dists.ts`.

## 6. Cloud, drivers, environment

### M39 — "six drivers" / brokering (§Cloud "where it works"; Part 1)
- Command: `grep -nE 'id: "|secretBrokering' packages/sandbox-manager/src/driver-catalog.ts`.
- Six real sandbox drivers: daytona, modal, vercel, cloudflare, box, docker (+`exe`, a local pseudo-driver) — **verified** dev and today.
- Plan prose (line ~191) says "**only** the Cloudflare and Daytona drivers can broker secrets" — **mismatch**: the catalog gives `secretBrokering: "native"` to **three** drivers (daytona, vercel, cloudflare), which matches the plan's own table row ("Works on Daytona, Vercel and Cloudflare") but not this sentence. List: [sandbox-drivers-dev.txt](lists/sandbox-drivers-dev.txt).

### M40 — Sandbox image pins (§What exists today for the cloud; C-13)
- `packages/claxedo-server/scripts/sandbox/Dockerfile` (and `cloudflare-worker/Dockerfile` ARG): `claude-code@2.1.150`, `codex@0.133.0`, `gemini-cli@0.43.0`, `pi-coding-agent@0.85.1` pinned by npm; `cursor-agent`, Amp, `droid` installed by unpinned `curl | bash` — **3 unpinned, verified** dev and today. No OpenCode CLI in the image — verified (no opencode install line).

### M41 — Validation pool "two workers, 32 MB each" (rules §7, ACP specifics)
- `acp/pattern-validation.ts:8-22`: `active >= 2` gate, `maxOldGenerationSizeMb: 32` — **verified** dev and today.

### M42 — Lint gate / T-3 "complexity limit (47)"
- Gate: `packages/agent-sdk-runtime/scripts/oxlint.json` has `"complexity": ["error", 35]`; plan's "(47)" is `switchHarness`'s measured complexity on dev, not the limit. Fix commit 5d6aa44139 is on the branch; `handoff-transaction.ts` is 327 lines today vs 286 on dev.

### M43 — `engines.node` / T-9
- `claxedo-server/package.json`: `"node": ">=22 <25"` — the crashing `/usr/local/bin/node` v22.13.1 was inside that range; the fix pins `CLAXEDO_E2E_NODE`. Verified.

### M44 — T-6 preloads
- `agent-sdk-runtime/bunfig.toml` preloads `src/test-utils/isolated-home.mjs`; `workspace-runtime/bunfig.toml` preloads `src/test-support/isolated-home.ts`; `claxedo-local-server/vitest.config.ts` has **no** setup/preload — matches "local-server has none".

## 7. Counts of things in the plan/repo

### M45 — Defect register size
- Part 1 says "24: 8 in the harness layer, 14 in cloud delivery, 2 in tests and docs".
- The register table has **36 rows**: H-1..H-12 (12), C-1..C-14 (14), T-1..T-10 (10) — `grep -cE '^\| (H|C|T)-[0-9]+ \|'` on the plan file. **Mismatch**: the prose was written before H grew to 12 and T to 10.

### M46 — Flow table
- 38 rows (H1–H37 plus H3b). "~90–100 flow-by-harness variants" is an estimate, not file-measurable.

### M47 — `harness-traces/` "11 files"
- `packages/claxedo-app/e2e/fixtures/harness-traces/` = 11 files, dev and today — **exact**.

### M48 — "32 of the old app's 58 e2e specs ran against a hand-written fake of 70 server routes"
- `find packages/claxedo-app -name '*.spec.ts'` = 58 — **exact**.
- Specs importing `e2e/helpers/mock-runtime.ts` (3,764 lines): **38** today on dev (34 `core-*` + 4 others) — plan's 32 is close but does not reproduce exactly; route-like handlers in the fake ≈ 69 — "~70" holds.

### M49 — Versions cited in the plan
- `@cursor/sdk` 1.0.24 ✓ (`agent-sdk-runtime/package.json`); `@agentclientprotocol/sdk` 1.3.0 ✓; image pins per M40; OpenCode "1.18.32" is the installed CLI (docs/harness-v2/profiles.md), not a repo pin; Cursor-worker rule references the same dep.

### M50 — npm: "13 `@claxedo/*` packages published; harness libraries at 0.8.0"
- Repo today: **15** non-private `@claxedo/*` package.jsons (incl. `opencode-server-adapter`, `egress-broker`; `process-ownership`/`harness` are private/absent from publish set). The 13 and the 0.8.0 version came from `npm view` on 2026-09-24 — external state, not verifiable from the tree; repo version fields now read 0.10.0/0.5.0/0.4.0/0.2.0/0.1.0.

### M51 — Executor "219k production lines; ~154k over 20 packages" (App. C)
- External repo (`github.com/RhysSullivan/executor` @ fec546e); not reproducible from this tree. Noted only.

### M52 — Process numbers (not code measurements; recorded for completeness)
- Flow qualification: 20 runs per new flow; 3 runs per side per gate; ~90–100 variants; 60 s flow budget; 2 workers/32 MB (M41); T-8's 28 CPU burners; T-9's Node v22.13.1; "~5k fewer lines" ACP-everything estimate — all estimates or environment facts.

### M54 — "all 18 rows" of the responsibility table (Part 1 §1)
- The table `## The core responsibilities` (plan lines 41–62) has **20 numbered rows**, not 18 — `grep -cE '^\| [0-9]'` on that range. Prose mismatch; table presumably grew after the sentence was written.

### M55 — `permission-ceiling.ts` "65 lines" (§Rebuilt table, broker row)
- Dev 65 — **exact**; today 66 (+1).

### M56 — "files under 300 lines" convention (conventions §Size)
- Budget, not a claim about today. Measured anyway: **35** production files >300 lines across the four packages ([list](lists/files-over-300-today.txt)).

### M53 — `packages/*/scripts/` ceremony (§Where the lines go)
- 22 `packages/*/scripts` dirs, 182 `.ts`/`.mjs` files on dev — outside `src/`, excluded from the 49.7k as claimed.

## Mismatch table

| # | Number (plan) | Plan value | Dev re-measure | Today (feat/harness-v2) | Why |
| --- | --- | --- | --- | --- | --- |
| M1 | Four-package production lines | 49,687 | 49,687 ✓ | 45,819 | ownership moved out, protocol generated, branch fixes |
| M2 | Test lines | 42,765 | 42,764 (−1, newline edge) | 40,710 | deletions on branch |
| M3 | Cases | ~1,470 | 1,445 (`test(`) or 1,476 (`it(` incl.) | 1,368/1,399 | pattern-dependent; "~" covers it |
| M4 | Process ownership | 2,222 | 2,222 ✓ | 2,255 | +33 T-10 UTC/pid fix on branch |
| M5 | Runtime host | 3,604 | 3,604 ✓ | 3,635 | +31 branch edits |
| M6 | Projection | 3,222 | **3,181** | 3,181 | `client-presentation` is 2,000 not 2,041 — off by 41 on dev itself |
| M12 | Codex protocol | 605 files / 6,713 | 605/6,713 ✓ | 0 committed (539/5,645 generated) | b5ff388d93 moved it to build-time generation |
| M21 | Operation surface | 96 members | 96 ✓ | **92** | SupportsRevert/Unrevert/Shell/Summarize deleted on branch |
| M25 | Codex notification methods | 75 | **65** | 65 | union members in ServerNotification.ts; 75 not reproducible |
| M18 | adapters/log/target/paths lines | 216 | 216 ✓ | 170 | glue files shrank −46 |
| M29 | Registry | 2,129 | 2,129 ✓ | 2,122 | small branch edits |
| M30 | Capabilities | 1,058 | 1,058 ✓ | 1,045 | small branch edits |
| M34 | agent-runtime-contract | "today 3.2k" | 3,216 ✓ | 3,466 (+250; 34 under the gate) | grew; P4 move will not fit as written |
| M37 | Local-server ceiling | 69/29 | 69/29 ✓ | 69/30 | process-ownership added to the closure |
| M39 | Secret-brokering drivers | "only Cloudflare and Daytona" (prose) | 3 native (daytona, vercel, cloudflare) | same | prose disagrees with the plan's own table |
| M45 | Defect count | 24 (8+14+2) | register has 36 rows (12+14+10) | same | prose predates T-3..T-10 and H-9..H-12 growth |
| M48 | App e2e specs on the fake | 32 of 58 | 38 import `mock-runtime.ts` | 38 | close; counting rule differs |
| M50 | Published `@claxedo/*` | 13 | n/a (external) | 15 non-private in repo | npm-side state, dated 2026-09-24 |
| M13 | Harness factories present | 100 lines | 100 ✓ | **0 — dir already deleted** | P0.3 ran on this branch |
| M54 | Responsibility-table rows | "all 18 rows" | 20 rows | 20 | prose predates table growth |
| M55 | `permission-ceiling.ts` | 65 | 65 ✓ | 66 | +1 |
| M31 | Contract bucket "~2.2k" | ~2.2k | 2,235 (set fit) | 2,006 | Supports* deletions + `harnesses/index.ts` gone |

Everything else in the plan verified exactly on `dev` and is either unchanged today or drifted for a stated reason.

_Generated for lane P0.7 (measurements). Re-run with `measure.sh`._
