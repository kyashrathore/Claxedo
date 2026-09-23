# CI green + staging live test — handoff (2026-09-23)

Goal: CI green on `origin/dev`, then a live test on the deployed staging app of
onboarding → sandbox (Cloudflare/Daytona) → AI provider → a real turn. Iterate in
local simulations (clean worktree sim, crabbox Windows boxes), push once per batch.

## Where things are

| Ref | Commit | State |
|---|---|---|
| local `dev` | tip (`git log -1 dev`) | Everything below merged. **Not pushed.** Gate not replayed on the final merge (`40daff7395` + docs). |
| `origin/dev` | `4659087e22` | Last push. CI on it: Linux unit + typecheck + release green; Windows unit, tier-real red (fixed locally, see below). |
| `origin/staging` | `4659087e22` | Deployed as release 90 (`release-staging-260923-141123-4659087e`), `/health` open. |
| `integrate/tonight` | = local `dev` | Integration branch in `.claude/worktrees/integrate-tonight`. |

Unpushed on local `dev` since `origin/dev`: the CI change that reports every
failure (`390294a1c2`, `ffc7686233`), the signed-web e2e fixes and the Pi idle-reap
fix (`d3fe51f4ea`..`ba71dffa02`), the web sign-in fix (`ba8dffd008` reworked by
`8f05d09c26`), the local-server Windows fixes (`e60d66aa77`..`2fd020b5df`), the New
Project / boot-splash fix (`31ea96947b`), and the merges of other sessions' dev work.

## Next steps, in order

1. **Replay the gate on local `dev`** in the clean sim
   (`scratchpad/ci-sim`: `git checkout --detach <sha> && bun install --frozen-lockfile`),
   then `bun run lint`, `bun typecheck`, `bun run test:ci-policy`,
   `bun run test:architecture-ratchets`, `bun turbo test --filter=@claxedo/app --force`,
   and full core e2e in both modes (`e2e-core-repro.sh <mode> --rebuild`, own `PLAYWRIGHT_PORT`,
   never 4455 — another session's Vite holds it).
2. **Collect the two Windows lanes still running** (below), review each diff, cherry-pick
   onto `integrate/tonight`, verify on macOS, fast-forward `dev`.
3. **Push `dev` once** (`git push origin HEAD:dev` from the integrate worktree; install
   `packages/claxedo-app/perf-harness` deps first or the pre-push lint fails on
   perf-harness "error" types). CI now uses `--continue` and a collecting tier-real loop,
   so one run shows every remaining failure.
4. **Deploy staging** by fast-forwarding `staging` to the pushed commit
   (`git push --no-verify origin <sha>:refs/heads/staging`); watch `deploy-staging`.
   It gates only on the gate + Linux unit (`linux-unit-only: true`), not Windows/tier-real.
5. **Live test** on `https://app-acc-stg-260830-232009-3851.claxedo.dev` (built-in browser):
   sign in with GitHub (user does it), New Project → wizard → Cloudflare cloud sandbox →
   Pi provider key (the user enters the OpenCode Go / OpenAI key) → first turn.

## Background work still running (do not duplicate)

- **Windows lane A** (worktree `.claude/worktrees/agent-a3e806aa951b7a24d`, branch
  `fix/windows-rest-2`, base `4208b4c1b8`, 9 commits): proven on Windows — cli,
  host-connector, ui, desktop (4 stages), workspace-relay (3 stages, process exits), app
  (bun 5927/0, vitest, tooling, deployed-acceptance), server shard 1/4 (774 tests). Also the
  Bun Windows bundler panic fix (`script/published-exports-plugin.ts`) and
  `cbx-ci-windows.ps1` installing perf-harness deps. Lease `quick-hermit` expired and is
  stopped; lease `blue-crayfish` is running server shards 3/4 and 4/4 (~70 min). Left for
  lane B: mcp `processes.test.ts` and 7 perf-harness EBUSY. `claxedo connect` refuses on
  win32 (folder serving is POSIX-only; rename-EPERM and private-key DACL recorded as
  prerequisites in the connect docs).
- **Windows lane B — FINISHED, not merged** (worktree `.claude/worktrees/agent-a2aace8da91c231e9`,
  branch `fix/win-workspace-runtime`, base `4659087e22`, 7 commits `0ba5dc0cff`..`5ca91453dd`,
  lease stopped). On Windows: workspace-runtime `bun run test` 1518 pass / 0 fail (+ relay 42,
  node 121), mcp `processes.test.ts` passes, agent-sdk-runtime acp 214/0; macOS suites green.
  Review before merging, in particular: node-pty ConPTY returns pid 0 at spawn (waits ≤6 s for
  the real pid); a **patch to `@opencode-ai/core`'s Bun SQLite adapter** to finalize statements
  (EBUSY root cause); `9732845309` touches agent-sdk-runtime (a crashed ACP child's retirement
  reports exited). Open from this lane: perf-harness still 10 Windows failures (6 EBUSY, likely
  the same unfinalized-statement leak in `claxedo-server-core` `db.ts` / drizzle Bun driver);
  managed processes start `/bin/sh` on Windows; terminal `PATH` joined with `:` on Windows;
  local-server's two terminal tests need a combined Windows rerun with `fix/win-local-server`
  (already on dev) + this branch, several times with `TURBO_FORCE=true`.
- Stop lane A's lease `blue-crayfish` when it finishes: `./script/cbx stop blue-crayfish`.

## Findings from the live staging test (open unless marked fixed)

- **Fixed (local dev):** web sign-in switched off when `/api/claxedo/bootstrap` answered
  after the 1.5 s render deadline ("Sign-in is unavailable: this Claxedo server issues no
  sessions"). Now starts at the deadline and again on a late "issues sessions".
- **Fixed (local dev):** New Project did nothing when every project's host is offline; the
  boot splash held 10–20 s on an offline workspace (`WorkspaceUnavailableSurface`).
- **Open — network:** staging and prod answer in 0.4–6 s from India with occasional 20 s
  hangs and a prod 522; requests land in SIN/MXP while cloudflare.com serves from HYD.
  Cloudflare routing for `claxedo.dev`, not app code. The app's 3 s health timeout turns it
  into "Could not reach …".
- **Open — known plan gap:** the hosted Models page can't store keys (credential routes 404
  on the hosted plane; see `docs/plans/2026-09-15-001-feat-onboarding-v2-project-ai-execution.md`
  §hosted gaps). Keys on hosted go through the wizard's Pi path only.
- **Open:** Models shows raw JSON for OpenCode on hosted
  (`provider_catalog_unsupported`, only Pi's catalog is served) — should hide OpenCode there.
- **Open:** General settings copy says "OpenCode" (language, color scheme labels).
- **Fixed (origin):** a staging release that failed its 15 s browser-attestation window
  left staging locked (503 on every API route, ~13:50–14:15 UTC); window is now ~66 s and
  `staging-release.ts` finishes a locked release before the next one.

## CI facts learned today

- Failures surfaced one layer at a time because turbo stopped at the first failing package,
  the tier-real loop at the first scenario, and later steps skipped after a failure. Fixed in
  `390294a1c2`; also replay every workflow a dev push triggers (packages-release, storybook,
  sandbox-image), not only `test.yml`.
- Windows had never passed the rest lane: ~130 failures across 9 packages were hidden
  behind the first failing package.
- Known flakes: "Show all preserves the visible line" (fixed on dev by `afb077880e`),
  permission picker "switching harness replaces the modes" (1× under full load, 20/20 alone),
  Codex interrupted-command reload (1× in CI, 20/20 locally).
