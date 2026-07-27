# Claxedo Cloud launch: every stream of work that must be done

- **Date:** 2026-07-27
- **Status:** EXECUTING (second pass, 2026-07-27 evening — §0 records the re-verified state, the owner's scope cuts, and per-stream dispositions; §0 supersedes stream statuses below where they conflict)
- **Owner intent:** ship Claxedo Cloud publicly. Four named asks: (1) all docs updated, (2) a Cloudflare deploy prompt with enough context that an agent can actually execute it, copyable from the website's secondary button, (3) npm packages updated, (4) Claxedo Cloud well covered with tests. This doc adds a fifth group the sweep surfaced: the launch-ops work that blocks the other four regardless.

Inherited operating principles (inlined; `docs/plans/goal.md` does not exist on `dev`):
- Exact Definition of Done per stream; a task without a runnable verification command is not done.
- **No false-positive verification:** green tests are claims. Every guard added here must be **tripwired** — break it on purpose, watch it fail, restore. Anything user-visible needs vision-reviewed screenshots or video, not a passing assertion.
- Local-first: replay locally before wiring CI, and never deploy to discover a failure.
- Strangler/additive: nothing removed until its replacement is green.
- Push parallel agents/workflows for independent streams; the parallelization map in §6 is normative.

---

## 0. Execution update — 2026-07-27 evening (authoritative over the sections below)

### 0.1 Owner direction (2026-07-27)

- A **staging Cloudflare deployment now exists** and deploys continuously from `dev`.
- **All local commits are pushed** (`origin/dev` == local `dev`).
- **claxedo.com is live.**
- **End-user Cloud docs are deliberately deferred** — the owner does not want AI-generated user docs. B4 and B5 are out of scope for this pass.
- The owner is **personally fixing the live-tier e2e specs**. Agents must not remove or touch any `live-*` spec or its tier wiring. M-tier is reported working by the owner.
- **Everything after F4 is deferred** — F5 (backup/DR), F6 (launch checklist), F7 (workspace-persistence status) are out of scope for this pass.

### 0.2 Re-verified state (all probes run 2026-07-27 ~18:00 UTC)

| Fact | Evidence |
|---|---|
| `origin/dev` fully pushed | `git rev-list --left-right --count origin/dev...dev` → `0 0` |
| Staging control plane **live and healthy** | `https://claxedo-control-plane-staging.kanusdlp.workers.dev/api/claxedo/health` → `{"ok":true,"mode":"hosted-control-plane","localExecution":false}`; `/api/claxedo/mode` → `signedAuth:true, authority:true, relay:true, workgraph:true` |
| Staging deploys are continuous, not one-off | Latest dev push (`0bcf5c42`): `deploy-control-plane` ✅, `deploy-claxedo-app-staging` ✅, `claxedo-sandbox-image` ✅. Relay staging worker also live (`claxedo-workspace-relay-staging.kanusdlp.workers.dev`). |
| Website + docs site live | `claxedo.com` → 200, `docs.claxedo.com` → 200. **But `www.claxedo.com` → 404**, and `redirects.json` `hostingBinding.status` is still `"unbound"` — the live hosting was bound out-of-band and the repo doesn't declare it. No `deploy-claxedo-web`/docs workflow exists in `.github/workflows/`. |
| CI on `dev` is **still red** | `test.yml` latest run (`0bcf5c42`) failing jobs: `typecheck` (in the separate typecheck.yml run), `unit (linux)`, `unit (windows)`, `local diagnostics release gate`, `e2e (linux 2/12, 4/12, 11/12)` |
| The typecheck failure | `packages/claxedo-server/src/routes/opencode-compat-provider-harness.test.ts(94,24)` TS2352 — fetch-typed cast needs `as unknown as typeof fetch` |
| The unit failures (same 5 on linux+windows) | `Markdown rich-mode detector > keeps the 100 KiB and 500 KiB probes responsive…`; `terminal recovery > clearing marker re-enables initial command`; `terminal recovery > claim blocks duplicate launch until released`; `terminal recovery > release re-enables claimed launch`; `workspace connection authority > offline classification: forbidden is terminal…` |
| The diagnostics-gate failure | `local production spawn inventory > classifies every checked process seam exactly once` (script `test:diagnostics-release`) |
| No `production` environment yet | `gh api repos/kyashrathore/Claxedo/environments` → only `staging`, `staging - packages/claxedo-docs` |
| Desktop drafts unreconciled | `gh release list -R kyashrathore/Claxedo` → v0.0.60/61/62 still Draft; 0.0.59 (2026-03-08) still Latest |

### 0.3 Revised stream dispositions

| Stream | Disposition | Note |
|---|---|---|
| A1 | **PARTIAL → executing** | Push done. Remainder = make CI green: the typecheck fix, 5 unit failures, the diagnostics-gate failure, e2e shards 2/4/11 (all @core M-tier — live-tier specs don't run in CI and are owner-territory). |
| B1 | executing | Conflict markers re-verified present at `AGENTS.md:189,191`. |
| B2 | executing (narrowed) | Deployed reality resolves the §7.3 decision de facto: `docs.claxedo.com` serves `packages/claxedo-docs` (Mintlify) and `claxedo.com/framework` syncs from it → `public-docs/` is the internal ops tree. Fix its README's false claim. Owner can veto. |
| B3 | executing | |
| B4 | **DEFERRED (owner)** | No AI-generated end-user docs. |
| B5 | **DEFERRED (owner)** | Same. The desktop-download staleness note folds into F2. |
| B6 | **PARTIAL → mostly owner** | Site + docs are live (bound out-of-band). Repo work left: make `redirects.json`/README stop claiming "unbound" once the owner declares the provider; `www.claxedo.com` 404 is a DNS/edge fix only the owner can do. |
| C1, C2 | executing | Prompt must now say staging exists and is continuously deployed (the "never executed" caveat below is superseded) while still instructing verify-don't-assume. |
| C3 | **DONE** | Evidence in §0.2. Residual: none — behavioral + workgraph smoke run inside the deploy workflow on every push. |
| D1, D2 | executing (publish gated) | All prep on a branch; the actual `npm publish`/workflow dispatch happens only after merge to `dev` with green CI. |
| D3 | executing (deploy gated) | Bumps + local `check:worker-safe` dry-run only; **no staging redeploy while the owner's live-tier work is in flight** — redeploy happens naturally on merge. |
| D4, D5 | executing | |
| E1 | executing | The highest-leverage stream, unchanged. |
| E2 | executing (after E1) | |
| E3 | executing | |
| E4 | **OWNER IN PROGRESS** | Owner is fixing live-tier specs now. Agents: hands off all `live-*` specs and tier wiring. The stale "runs nightly" comment gets corrected only as part of the owner's own pass. |
| F1 | executing (prep only) | Runbook + exact commands + secret inventory; environment creation, secret values, and the supervised promote are owner actions. |
| F2 | executing (fix only) | Fix the electron `minimum-release-age` block so the pipeline can run; draft reconciliation (§7.4) and the actual tag cut are owner actions. |
| F3 | executing | Fresh-profile onboarding run + vision review vs D1–D11; flag decision stays with owner after evidence. |
| F4 | executing | Includes verifying/fixing the critical unauthenticated `publicMutation` cancel-subscription finding at `convex/orgs.ts:239` from the 2026-07-27 security review, CORS/log-scrubbing/rate-limit review, and a light abuse probe against the now-live staging worker. |
| F5, F6, F7 | **DEFERRED (owner)** | "Leave all after F4." Caution left on record for F7: the persistence design (`2026-07-27-004`) is PLANNED, not built — website copy must not claim durable cloud workspaces until it is. |

### 0.4 §7 owner decisions — updated

1. Hosting/edge owner: **resolved in practice** (site live). Still owed: declare the binding in-repo and fix `www.claxedo.com`.
2. Analytics owner: **still open.** Flag: the 2026-07-27 tracking review found all telemetry dead (zero PostHog wiring in workflows, zero identify calls) — whoever owns analytics inherits that.
3. `public-docs/` role: **resolved de facto as internal** (see B2).
4. Draft releases v0.0.60/61/62: **still open — owner.**
5. Onboarding flag: **open, pending F3 evidence.**
6. Cloud persistence claim: **deferred with F7**, caution recorded in §0.3.

---

## 1. How this was produced, and how much to trust it

Six Sonnet subagents ran read-only over `dev`: five area auditors (docs, the Cloudflare deploy prompt, npm state, Cloud test coverage, cross-cutting blockers) and one adversarial completeness critic that re-checked the others' highest-consequence claims against the repo and the GitHub API.

Every claim below is anchored to a file path, a command's output, or a `gh api` response. Where a claim could not be verified it is marked **unverified** and is a task, not a fact. Three claims were independently re-verified by hand after the audits (§3).

One auditor (docs, first attempt) returned placeholder text instead of an audit and was discarded and re-run; the results here are from the re-run.

---

## 2. State of the world (verified)

### 2.1 What is genuinely in good shape

| Area | Evidence |
|---|---|
| Billing infra is built and fails closed to free | `packages/claxedo-server/src/billing/entitlement.ts:72` — `if (state.plan !== "pro") return { entitled: false, reason: "free_tier" }`. Polar webhooks, seat caps, replay protection all have tests. Matches the launch-free intent. |
| Marketing copy is honest, not placeholder | Grep for TODO/FIXME/lorem/"coming soon" across `packages/claxedo-web/src` found 2 incidental hits, neither in Claxedo's own claims. `pricing.astro` correctly states no billing yet. |
| Package READMEs are command-accurate | Sampled root README, CONTRIBUTING, and all 12 public package READMEs — every cited script resolves to a real `package.json` script. |
| npm versions are currently *in sync* | All 12 public `@claxedo/*` in-repo versions exactly match npm as of the 2026-07-20 14:12–14:13 UTC batch publish. The problem is drift *since*, not divergence today. |
| `packages/claxedo-docs` is real content | 47-file Mintlify `.mdx` tree with a real `docs.json` nav. Not a stub. |
| claxedo-server is the best-tested package in the repo | 227 `*.test.ts` files covering billing, JWKS, rate limits, tenant policy, plus 2 genuine Miniflare runtime tests. |

### 2.2 The five facts that most change the plan

1. **CI runs almost none of the tests that exist.** `turbo.json` has *no* generic `test` task — only five package-scoped entries (`opencode#test`, `@opencode-ai/core#test`, `@opencode-ai/ui#test`, `@opencode-ai/session-ui#test`, `@claxedo/app#test`). `.github/workflows/test.yml:166` runs bare `bun turbo test`, so **claxedo-server's 227 test files and ~257 more across 12 other `@claxedo` packages never gate a PR or a deploy.** The only gate on a control-plane deploy is TypeScript compiling plus a 4-assertion post-deploy smoke. *(Independently re-verified — see §3.)*

2. **[SUPERSEDED — see §0.2: pushed to 0/0; CI still red with a narrower failure set]** **`origin/dev` is 93 commits behind local and has not been green in 5 consecutive runs.** `git status` → ahead by 93. `gh run list --workflow test.yml --branch dev --limit 5` → all five `conclusion: failure` (2026-07-24 → 2026-07-26), failing e2e shard 11/12 on `core-timeline-rendering-scroll.spec.ts` and `core-user-hosted-workspace.spec.ts`. Local `dev` also carries 18 modified + 2 untracked files never seen by CI.

3. **[SUPERSEDED — see §0.2: staging is live, healthy, and continuously deployed; the "no `production` environment" half is still true]** **The Cloudflare deploy has never been executed.** No staging deployment of the hosted control plane has ever been run. And `gh api repos/kyashrathore/Claxedo/environments` returns only `staging` and `staging - packages/claxedo-docs` — **no `production` environment exists**, so the `promote-production` job in `deploy-control-plane.yml:311-315` has no gate and no secrets.

4. **[PARTIALLY SUPERSEDED — see §0.2: claxedo.com and docs.claxedo.com are live, bound out-of-band; still true that no workflow in-repo deploys them, `www` 404s, and `redirects.json` says "unbound"]** **Nothing publishes the website or the docs.** No workflow in `.github/workflows/` deploys `claxedo-web` or `claxedo-docs`. `packages/claxedo-web/deploy/redirects.json` says `hostingBinding.status: "unbound"`. Meanwhile the root README links `claxedo.com` as if live.

5. **There is no end-user Cloud documentation at all.** Grep across all 47 `claxedo-docs` `.mdx` files: zero hits for pricing/free-tier/per-seat, zero for sign-up/create-an-account, zero for troubleshoot. Every doc surface is framework/self-host/developer material. A person who signs up for the hosted product has nothing to read.

### 2.3 The deploy prompt, specifically

`packages/claxedo-web/src/content/deployment.ts` is a well-ordered, safety-conscious *procedural* checklist that contains exactly one repo-specific fact (`packages/claxedo-server/wrangler.toml`) and zero binding names, env var names, or commands. The words **"Convex" and "Clerk" never appear in it** — yet both are hard, fail-closed boot requirements of the Worker (`hosted-compose.ts` `storageUrl()` requires the Convex authority URL; the Worker 503s at boot without `CLERK_JWT_ISSUER`/`CLERK_JWKS_URL`). It also never links the repository, so a visitor who copies it has no checkout to point an agent at.

The real deploy is a **4-unit ordered release**: Convex schema (`convex/`) → workspace-relay Worker → claxedo-control-plane Worker → claxedo-app Pages, driven by ~30 GitHub environment secrets, with `wrangler r2 bucket create` and the sandbox-image workflow as unlisted prerequisites.

---

## 3. Corrections to the audit findings (do not act on the retracted item)

| Claim | Verdict |
|---|---|
| "`hosted-shell.ts` has untested command-execution routes" — filed as a launch-blocker | **RETRACTED.** Verified by hand: `grep -cniE "child_process\|spawn\(\|execFile\|\bexec\("` → **0**. "Shell" here means the *app shell frontend*, not an OS shell. Its routes are SSE, bootstrap, health, config, project, path, provider. There is no exec surface. **But** it does expose `PUT`/`DELETE /auth/:providerID` (`hosted-shell.ts:341,354`) — credential storage — which is genuinely untested. Stream **E3** is retargeted to that. |
| "CI runs zero @claxedo tests" (prior project memory) | **Partly stale.** `test.yml` does have real `unit`, `e2e` (12-way sharded), and `e2e-workgraph` jobs, and `@claxedo/app#test` *is* wired. The accurate statement is narrower and still severe: 13 `@claxedo` packages incl. claxedo-server are excluded. Memory should be updated. |
| "Last two origin/dev runs failed" | **Understated.** It is at least five consecutive runs across three days. |
| "`pnpm-workspace.yaml` is the catalog" (assumed in the audit brief) | **False.** Bun reads `package.json` `workspaces.catalog`. `pnpm-workspace.yaml` is unreferenced dead documentation that has already drifted (effect beta.66 vs beta.83, opentui 0.2.15 vs 0.3.4). |
| "12 orphaned packages just need their test task enabled" | **Understated.** 6 of them (claxedo-server, mcp, channels, connections, sandbox-manager, wakes) do not appear in `bun turbo test --dry=json` output *at all* — they need new turbo wiring, not a flag. Stream E1 is therefore **L**, not M. |

---

## 4. The streams

Estimates: S ≈ under a day, M ≈ 1–3 days, L ≈ ~a week, XL ≈ more.

### Group A — Ground state (blocks nearly everything)

#### A1 — Catch `origin/dev` up and get CI green — **M**
**Why:** 93 unpushed commits and a 5-run red streak mean nothing outside this laptop has been verified. Any deploy pulling `origin/dev` today ships on a red build, and every other stream's DoD ("CI is green") is unmeasurable until this lands.

Tasks:
- Triage the e2e failures on the last 5 `origin/dev` runs (`core-timeline-rendering-scroll.spec.ts`, `core-user-hosted-workspace.spec.ts`) — confirm whether already fixed locally.
- Commit or explicitly review the 18 modified + 2 untracked files on local `dev` (permission-mode / provider-auth / a11y fixes, `script/cbx-prepare.sh`, `opencode-compat-provider-harness.test.ts`). **Use `git commit --only <paths>`** — a shared index has previously swept another agent's staged files.
- Push to `origin/dev` in reviewable batches, watching CI on each.
- Re-baseline `docs/known-issues.md` once green.

**DoD:**
- `git status` on `dev` reports 0 ahead of `origin/dev`, or a written, deliberate reason for staying ahead.
- `gh run list --workflow test.yml --branch dev --limit 1` → `conclusion: success`.
- No uncommitted change remains unaccounted for.

**Depends on:** nothing. **Start here.**

---

### Group B — Documentation (ask #1)

#### B1 — Remove the committed merge-conflict markers from `AGENTS.md` — **S**
**Why:** `AGENTS.md:189` (`=======`) and `:191` (`>>>>>>> 5117bfb5ca`) are live conflict markers on `dev`. This is the first file every contributing agent reads, and it currently ends mid-conflict. *(Verified by hand.)*

Tasks: resolve the block at 189–191 — reconcile the duplicated "Type Checking" guidance against the V2 Session Core section it collided with; sweep every tracked file for the same artifact.

**DoD:** `grep -rn "^<<<<<<<\|^=======$\|^>>>>>>>" --include="*.md" . ` (excluding `.worktrees/`, `.claude/`) returns zero hits.
**Depends on:** nothing.

#### B2 — Declare one canonical published-docs surface — **M**
**Why:** Three doc trees exist and one lies about the others. `public-docs/README.md:3-5` claims "the hosted site is assembled from it," but `packages/claxedo-web/scripts/sync-framework-docs.ts:4` sources from `packages/claxedo-docs` and never touches `public-docs`. The two trees are hand-maintained duplicates (`public-docs/self-host-fly.md` vs `claxedo-docs/deploy/self-host-fly.mdx` are near-identical, both last edited in the same commit `a78f614a84`). Every downstream doc stream doubles in cost until this is settled.

Tasks:
- Decide: `public-docs/` = internal ops-runbook tree (it is already referenced by `deploy-{convex,control-plane,relay}.yml` for rollback), or a public source.
- If internal: rewrite `public-docs/README.md` and drop the false assembly claim.
- If public: extend `sync-framework-docs.ts` to include it, or fold its unique content into `packages/claxedo-docs`.

**DoD:**
- `public-docs/README.md` makes no claim contradicted by `sync-framework-docs.ts`.
- Exactly one README states the canonical source for `claxedo.com/framework`.
- `packages/claxedo-web/test/framework-routes.test.ts` still passes (it asserts the 47-file sync).

**Depends on:** B6 (you cannot name a canonical *published* surface before anything is published). Can start the decision in parallel.

#### B3 — Fix broken internal links and add a link check — **S**
**Why:** `docs/README.md:23-25` links `./tech-docs/README.md`, which does not exist — in the doc whose entire job is being the trustworthy pointer set.

Tasks: fix or create the target; wire a link check for `docs/` and `public-docs/` (`packages/claxedo-docs` already ships `mintlify broken-links`).

**DoD:**
- `bun --cwd packages/claxedo-docs run broken-links` passes.
- A script/CI check resolves every relative `](...)` link under `docs/` and `public-docs/`; **tripwire it** by pointing one link at a nonexistent file and watching it fail.

**Depends on:** nothing.

#### B4 — Write the end-user Claxedo Cloud docs — **M** — ⏸ DEFERRED (owner: no AI-generated user docs)
**Why:** This is the single biggest documentation gap. Zero pages anywhere address someone signing up for the hosted product. Verified by full-text grep across all 47 `.mdx` files: no pricing, no signup, no troubleshooting.

Tasks:
- "Get started with Claxedo Cloud" — signup → first session, no self-hosting content.
- Pricing/limits page reflecting the launch-free model (and what happens when billing begins).
- "Cloud vs self-host vs local" comparison — what runs where, what each requires.
- Troubleshooting / FAQ.
- Link all four from the `docs.json` "Start here" nav group.

**DoD:**
- `packages/claxedo-docs/docs.json` nav contains a Cloud/Get-started group with these pages.
- Each new `.mdx` is >40 lines, no TODO/lorem placeholders.
- A reader who has never seen the repo can follow the getting-started page end-to-end against the deployed product — verified by an actual run, not by review.

**Depends on:** B2 (so it isn't written into the wrong tree), and realistically F1 (there must be a Cloud to get started with).

#### B5 — Backfill docs for shipped features — **S–M** — ⏸ DEFERRED (owner: no AI-generated user docs; download-staleness note folds into F2)
**Why:** Real user-visible behavior has zero public documentation. WorkGraph's approval gate (`pending_approval` / "Staged", `executionMode` deleted) appears only in internal plan docs — grep across `docs/`, `public-docs/`, `claxedo-docs/` finds it nowhere public. Same for the permission-modes work and opencode-compat provider routing.

Tasks: add "How WorkGraph approval works" to `packages/claxedo-docs/packages/workgraph.mdx`; document the per-harness permission-mode model; add a version/staleness note wherever the desktop download lives (or gate the link until F2 lands).

**DoD:** `workgraph.mdx` contains an accurate description of `pending_approval`/"Staged"; the permission-mode doc names Claxedo's single Auto mode and the per-harness modes without claiming a capability a harness lacks; the desktop download surface either shows a currency note or is unpublished.
**Depends on:** B2.

#### B6 — Ship the docs/marketing deploy pipeline — **L**
**Why:** Nothing deploys `claxedo-web` or `claxedo-docs`. `redirects.json` is `"unbound"`. The website plan (`2026-07-20-001`) says production cutover is the only remaining gap, blocked on a named hosting/edge owner and a named analytics owner — **these are owner decisions, not engineering work** (see §7).

Tasks: name the hosting/edge and analytics owners; add a build+deploy workflow for `claxedo-web`; bind `redirects.json`; retire the legacy docs deployment *without* 404ing existing links; capture deployed smoke evidence. Also fix `www.claxedo.com`, which 404s today while the apex returns 200.

**DoD:**
- `.github/workflows/deploy-claxedo-web*.yml` exists with a green run against a real URL.
- `redirects.json` `hostingBinding.status` is no longer `"unbound"`.
- `curl -o /dev/null -w '%{http_code}' https://www.claxedo.com` returns 200 or a 3xx to the apex.
- Every previously-live docs URL either still resolves or 301s.

**Depends on:** §7 owner decisions.

---

### Group C — The Cloudflare deploy prompt (ask #2)

#### C1 — Rewrite the deploy prompt with concrete, verifiable repo facts — **M**
**Why:** This is the ask verbatim. Today's prompt is procedurally sound but has near-zero grounding value: an agent following it must rediscover every binding, env var, and command from a cold read, and nobody can tell in advance whether that rediscovery succeeds.

Tasks — rewrite `packages/claxedo-web/src/content/deployment.ts` to name:
- **The 4-unit release order:** Convex schema (`convex/`) → `packages/workspace-relay` Worker → `packages/claxedo-server` Worker → `packages/claxedo-app` Pages.
- **The bindings verbatim:** `WORKGRAPH_SETTLER`/`WorkGraphSettler`, `WAKE_LANE`/`ClaxedoWakeLane`, `LIVE_SYNC_ROOM`/`LiveSyncRoom`; R2 `CLAXEDO_DOCUMENTS` → buckets `claxedo-documents` / `claxedo-documents-staging`; the `*/15 * * * *` cron; `compatibility_date` and the `nodejs_compat` / `global_fetch_strictly_public` flags.
- **Convex and Clerk as hard prerequisites, stated early and unmissably** — not as flat rows in a table. Name `CONVEX_DEPLOY_KEY`, `CLERK_JWT_ISSUER`, `CLERK_JWKS_URL`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` (svix, pointed at `convex/http.ts`), and the fail-closed 503-at-boot behavior.
- **That this is the hosted path only.** `wrangler.toml` hardcodes `CLAXEDO_DEPLOYMENT_MODE = "hosted"`. A Convex/Clerk-free self-host is a different shape this button does not serve — say so rather than letting a reader discover it.
- **The real verification commands:** `bun run check:worker-safe` (wraps `wrangler deploy --env staging --dry-run --outdir dist-worker`), `bun run smoke:workgraph`, and the curl sequence against `/api/claxedo/health`, `/mode`, `/compatibility`, `/.well-known/jwks.json`.
- **The unlisted prerequisites:** `wrangler r2 bucket create` before the Worker deploy, and the `claxedo-sandbox-image` workflow (which emits the `CLAXEDO_SANDBOX_BUILD_ID` the Worker deploy passes).
- **Relay disambiguation:** `packages/workspace-relay/wrangler.toml` only. Never `wrangler-h2.toml` (a tear-down experiment) and never `fly.toml` (the non-Cloudflare shape).
- **`bun install` at root, then `bunx wrangler`** — not `npx wrangler` as the in-repo comments say, which would resolve an unpinned version instead of the workspace-pinned 4.50.0 CI uses.
- **The honest caveat (updated 2026-07-27):** staging *has* now been deployed and redeploys continuously from `dev` (§0.2), but production has never been stood up. Instruct the agent to verify each step against its own target account rather than assume this repo's staging success transfers, and to stop-and-report on divergence.

**DoD:**
- Every binding name, env var, and command listed above appears in `deployment.ts` and is grep-verifiable against the actual `wrangler.toml` / `package.json` it claims to describe. **Add a test that does exactly this diff**, so the prompt cannot silently drift from the config.
- A reader with no other context correctly identifies Convex + Clerk as mandatory before touching Cloudflare.
- At least one runnable verification command per deploy unit.
- **Tripwire:** rename a binding in `wrangler.toml`, watch the new drift test fail, restore.

**Depends on:** nothing. Can start immediately.

#### C2 — Give the button a repo affordance — **S**
**Why:** The prompt opens "from this repository" but nothing on the page supplies one. `index.astro:34` and `:113` render the button with no adjacent repo link; the only `github.com` URLs in the site content point at *competitors*.

Tasks: put `https://github.com/kyashrathore/Claxedo` next to the button and inside the copied text, prefixed with a clone-and-cd instruction so the prompt is self-sufficient when pasted into a fresh agent session.

**DoD:** the rendered page places a working repo link within one visual unit of the button; the copied text alone lets a brand-new agent session with no repo open get started. Verify by actually pasting it into a fresh session.
**Depends on:** C1 (same file).

#### C3 — Execute the first real staging deploy — **L** — ✅ DONE (see §0.2 for evidence)
**Why:** C1 surfaces "this has never been run" to every reader. Before advertising the button as launch-ready, the path should have been walked once. **Merged here:** the CF auditor's staging-deploy stream and the cross-cutting auditor's production stream were two overlapping proposals for the same first-ever deploy; they are now one ordered sequence with F1.

Tasks: run the staging sequence end-to-end against the release-acceptance criteria (Convex dry-run + deploy, relay Worker, control-plane Worker, behavioral smoke, WorkGraph cross-tenant smoke, deployed browser journey); record the evidence; update `public-docs/deploy-runbook.md` to reflect a real run.

**DoD:**
- A real staging deployment has actually been executed (not merely documented as pending).
- A recorded staging Worker URL returns `ok:true` on `/api/claxedo/health` and `signedAuth:true` on `/api/claxedo/mode`.
- The WorkGraph cross-tenant smoke passes against it.

**Depends on:** A1. **Blocks:** F1.

---

### Group D — npm (ask #3)

Scope note: the owner asked for planning only on npm. Both readings are covered — republish (D1–D2) and dependency upgrades (D3–D5). Nothing is executed by this doc.

#### D1 — Version-bump and republish the 12 public packages — **M**
**Why:** Versions match npm today, but `agent-sdk-runtime` and `workspace-runtime` each have **16 commits since the 2026-07-20 publish** with no version bump — including the entire permission-modes overhaul and the terminal fixes. Anyone installing today gets pre-rework code with no signal from the version number.

Tasks:
- Per package, `git log --since=2026-07-20T14:13:30Z -- packages/<dir>` to decide who needs a bump (agent-sdk-runtime and workspace-runtime confirmed; re-check the other 10 at execution time).
- Regenerate `script/PUBLISH-ORDER.md` — it is dated 2026-07-18 and documents a 0.5.2/0.2.0 scheme that was superseded by the 0.6.0/0.3.0 release two days later. Running it verbatim today gives wrong targets.
- Update the exact `@claxedo/*` cross-pins wherever a dependency's version moved.
- Run `script/publish-preflight.sh` against all 12; fix every FAIL first.
- Dispatch `claxedo-runtime-release.yml` for the 6-package runtime family; run the regenerated manual sequence for the other 6 in dependency order.

**DoD:**
- `script/publish-preflight.sh` reports 12/12 PASS immediately before publish.
- `npm view <name> version` for all 12 equals the new `package.json` version.
- `PUBLISH-ORDER.md`'s scheme matches what was actually published, dated today.
- No published `package.json` contains a `workspace:` or `catalog:` specifier.

**Depends on:** A1 (do not publish off a red build).

#### D2 — Close the publish-automation gap for the other 6 — **M**
**Why:** `publish-runtime-packages.ts` automates only 6 of 12 (workspace-relay-protocol, workspace-relay, agent-event-runtime, agent-sdk-runtime, agent-extensions, workspace-runtime). The other 6 — channels, connections, mcp, sandbox-manager, wakes, workgraph — are published by a human typing commands out of a markdown file, with no dry-run and no idempotency check.

Tasks: extend the existing script (or add a sibling) covering the remaining 6, reusing its workspace-specifier check, npm-view-before-publish skip, and `--dry-run`; decide whether they stay independently versioned; wire into a `workflow_dispatch` job with the existing NPM_TOKEN/provenance setup.

**DoD:**
- One documented command (or one workflow) publishes any of the 12 with no manual `npm publish`.
- The new path runs the same tarball checks `publish-preflight.sh` encodes.
- A `--dry-run` runs in CI on every push to `dev` touching those 6 package dirs.

**Depends on:** D1.

#### D3 — Cloudflare tooling currency — **M**
**Why:** CF is the first-class deploy target, and the tooling is materially stale: `wrangler` pinned 4.50.0 vs 4.114.0 current (~64 releases); `@cloudflare/workers-types` 4.20251008.0 vs a new major; `compatibility_date` is `2025-05-01` (and `2025-04-01` in the sandbox worker) across all four `wrangler.toml` files — over a year old, on exactly the platform the hosted product lands on.

Tasks: bump wrangler and workers-types; review CF's compatibility-flags changelog across the gap before moving `compatibility_date`; re-run the staging deploy workflows against the bumps before touching production config.

**DoD:** wrangler matches latest 4.x; workers-types on current major with `bun turbo typecheck` green; all four `compatibility_date` values updated; relay/control-plane/sandbox-worker staging deploys green post-bump.
**Depends on:** C3 (a staging deploy must exist to re-run).

#### D4 — Low-risk dependency bumps — **S**
**Why:** solid-js, zod, hono, playwright and the dev-only tools are behind by minors/patches with no launch-blocking reason to hold them.

Tasks: solid-js 1.9.10 → 1.9.14 (re-verify `patches/solid-js@1.9.10.patch` still applies); zod 4.1.8 → 4.4.3; hono 4.10.7 → 4.12.32; @playwright/test 1.59.1 → 1.62.0 (then `playwright install` + a targeted shard); dev tools independently.

**Explicitly excluded from this stream:** vite (a major behind), astro (two majors behind), `tokentracker-cli` (**must stay EXACT-pinned**, library-only — do not let a bulk bump sweep it), and the `@typescript/native-preview` nightly pin. Each needs its own scoped investigation.

**DoD:** `bun turbo typecheck` green after each bump; targeted vitest file lists pass for zod/hono consumers (**never run the full claxedo-server suite — it hangs**); a written note records which majors were deliberately deferred and why.
**Depends on:** A1.

#### D5 — Retire or reconcile `pnpm-workspace.yaml` — **S**
**Why:** Repo-wide grep finds zero references to it outside itself. Bun reads `package.json` `workspaces.catalog`. The two have already drifted (effect beta.66 vs beta.83, opentui 0.2.15 vs 0.3.4, @pierre/diffs 1.1.0-beta.18 vs 1.2.10). It is a live source of wrong answers — this audit's own brief was misled by it.

Tasks: confirm nothing external depends on its presence; delete it, or regenerate it and add a CI check that fails on divergence.

**DoD:** either the file is gone, or a CI job fails on any divergence from `package.json`'s catalog — **tripwired**.
**Depends on:** nothing.

---

### Group E — Claxedo Cloud test coverage (ask #4)

#### E1 — Wire the 13 orphaned `@claxedo` packages into CI — **L**
**Why:** **The highest-leverage stream in this document.** 484 existing test files provide zero CI signal today. No new tests need writing — this is purely making what exists gate merges. A regression in a billing webhook signature check, a tenant-isolation handler, or JWKS rotation can merge to `dev` and deploy to staging with no automated signal whatsoever.

Sized **L**, not M: six of the thirteen (claxedo-server, mcp, channels, connections, sandbox-manager, wakes) do not appear in `bun turbo test --dry=json` output *at all* — they need new turbo task wiring, not a flag flip. And claxedo-server's full suite is known to hang.

Tasks:
- **First**, fix the claxedo-server hang before wiring it in blocking. Likely `fileParallelism: false` plus 60s per-test timeouts across 227 serialized files. Consider splitting a fast unit shard from a slower integration/miniflare shard with separate jobs and timeouts. *A hung CI job is worse than a currently-silent gap.*
- Add `#test` task entries for all 13 to `turbo.json` (or an explicit filter list in `test.yml`).
- Add junit reporting matching the existing `packages/*/.artifacts/unit/junit.xml` pattern.

**DoD:**
- `bun turbo test --dry=json` lists `#test` taskIds for all 13.
- **Tripwire:** deliberately break one claxedo-server test, watch `test.yml`'s `unit` job go red, restore.
- claxedo-server's suite completes inside the existing 20-minute job timeout without hanging.

**Depends on:** A1 — turning on a stricter gate while the existing one is red makes pre-existing and newly-introduced failures indistinguishable.

#### E2 — Real Convex-runtime tests for tenant isolation and billing — **L**
**Why:** `/convex` has **no test files at all**, and `convex-test` is used nowhere in the repo. The ~15 `convex-*-policy.test.ts` files import real Convex function bodies but run them against a hand-rolled in-memory `db()` fake that reimplements `.withIndex`/`.collect`/`.unique`. Real schema constraints (47KB `schema.ts`), real indexes, and real `ctx.auth` identity are never exercised. For a multi-tenant product, cross-org isolation deserves at least one layer of test against the actual backend.

Tasks: evaluate `convex-test` against this schema and the custom `serviceMutation`/`authedMutation`/`cronMutation` wrappers before committing; add integration tests for the highest-risk functions (`applyClerkWebhook`/`membershipByClerkIds` in `orgs.ts`, `applyPolarState`/`checkoutContext` in `billing.ts`, the sandbox-lease and local-host-link attestation functions, org-scoped WorkGraph reads/writes); keep the fake-db tests as a fast pre-check.

**DoD:**
- At least one `convex-test` file instantiates the real `schema.ts` and calls the real exported function.
- An explicit cross-org denial test exists for each of: workspaces, sessions, billing entitlement, sandbox leases — **org A's valid token cannot read org B's row**. Tripwire each.
- Wired into CI per E1.

**Depends on:** E1.

#### E3 — Route-test the genuinely uncovered security surfaces — **S**
**Why:** *Retargeted from the retracted `hosted-shell` exec claim (§3).* The real gaps are: `hosted-shell.ts:341,354` — `PUT`/`DELETE /auth/:providerID`, provider **credential storage**, whose only test file covers the extension catalog and machine-scan; and `opencode-compat-git.ts` — 121 lines of git branch/worktree logic on the compat HTTP surface with no functional test at all (referenced only by a static import-graph check).

Tasks: write credential-route tests asserting unauthenticated → 401, cross-workspace credential access rejected, malformed payload rejected; write `opencode-compat-git.test.ts` asserting 401, workspace-scoped directory enforcement, and path-traversal rejection.

**DoD:** each of the two surfaces has ≥3 passing tests covering auth-required, scoping-enforced, malformed/traversal-rejected. **Tripwire the scoping assertion on each** — remove the check, watch it fail, restore. Included in E1's CI wiring.
**Depends on:** nothing (can be written now, gated by E1).

#### E4 — Un-gap or formally retire the live e2e tier — **M** — 🔒 OWNER IN PROGRESS (do not touch `live-*` specs or tier wiring)
**Why:** `test.yml:264-266` claims the Tier M and Tier L suites "run nightly on a separate schedule." **No `schedule:` trigger exists in any of the 13 workflow files.** Only 28 of 34 Playwright specs carry `@core` and run on PR. The six that don't include `live-real-harness-smoke.spec.ts` — the *only* spec that removes all mocking and drives a real claxedo-server + real embedded OpenCode engine + real subprocess harness — and `live-user-hosted-relay.spec.ts`, the only spec touching the real relay hop. Both are effectively dead. The stale comment actively conceals this.

Tasks: decide — add a genuine `schedule:` cron with the live credentials and harness binaries those specs need, or delete the false claim and document them as manual-only. Audit other workflow comments for the same "runs elsewhere" fiction.

**DoD:** either a `schedule:` trigger runs the five `live-*` specs nightly with a green run visible in Actions history, or `test.yml`'s comment is corrected to state they run only via `test:e2e:all` by hand.
**Depends on:** A1.

---

### Group F — Launch operations (not asked, but blocking)

#### F1 — Stand up the production environment — **L**
**Why:** `gh api` confirms no `production` environment exists. There is no promote gate, no production secrets, and production has never been deployed. This is the hard gate on launch day.

Tasks: create the `production` GitHub Environment with required reviewers; provision production secrets (Cloudflare, Convex, Clerk, Polar, Sentry) **separate from staging**; document the account boundary so no staging credential reaches prod; run one supervised `promote-production`.

**DoD:** `gh api repos/kyashrathore/Claxedo/environments` lists `production` with protection rules; one human-approved promote completes; the production URL passes a health check and one real end-to-end signup, with a named on-call owner.
**Depends on:** A1, C3.

#### F2 — Unblock and cut a real desktop release — **M**
**Why:** The pipeline is **broken, not merely idle**. The last real tag push (`claxedo-v0.0.63`, 2026-07-24) failed in 46s: `No version matching "electron" found for specifier "43.2.0" (blocked by minimum-release-age: 259200 seconds)` — before any platform built. The public download page still serves `0.0.59` from 2026-03-08, ~4.5 months stale, with no working auto-updater feed.

Tasks:
- Fix the `minimum-release-age` rejection on electron@43.2.0 — pin an already-aged version or deliberately adjust the trust policy. **First check whether a fix is already among the 93 unpushed commits.**
- **Reconcile the three stale draft releases** `v0.0.60/61/62` (draft, macOS-only, 9 assets each) — delete, finish, or supersede. Do not cut a new release on top of a confusing draft history.
- Re-run `release-claxedo.yml` from a real tag push through all five platform legs.
- Verify the `latest.yml`/`latest.json` updater feed against the shipped app's updater config.
- Publish (undraft) and update `packages/claxedo-web/src/config.ts`.

**DoD:** a green tag-triggered run covering all 5 platform artifacts; `gh api .../releases/tags/<tag>` returns `draft:false` with 12 assets matching the 0.0.59 shape; `config.ts` version matches and download links resolve; in-app auto-update verified on ≥1 platform by vision review.
**Depends on:** A1.

#### F3 — Verify onboarding v1 — **M**
**Why:** Onboarding is the first-run experience for a free launch. It is flag-gated (`VITE_CLAXEDO_ONBOARDING_V1`, `rail-workbench-canvas.tsx:10`) and its plan doc catalogs **11 reviewer-found UX defects (D1–D11)** from the 2026-07-25 desktop run — no scrim, broken-looking checkmarks, no back navigation, an unscrollable Connect-AI step, save failures, dismiss offered on essential steps. Whether these are fixed is **unverified from static reading.**

Tasks: fresh-profile run via the `onboarding-desktop` skill, vision-reviewed against D1–D11; decide the production flag state deliberately; if not ready, decide whether the legacy floating setup card is acceptable for launch.

**DoD:** screenshots or video showing each of D1–D11 resolved or explicitly deferred with owner sign-off; the production flag setting documented and matching the decision.
**Depends on:** A1.

#### F4 — Pre-launch security review — **M**
**Why:** *No auditor proposed this; the critic caught the gap.* A multi-tenant hosted product is launching with no security pass. The primitives exist (13 files reference rate limiting; `rate-limit.ts`, `hosted-device-auth.ts`, `internal-admin-auth.ts`, `proxy.ts`) but nothing verifies they are launch-tuned.

Tasks: secret-scrubbing in logs; CORS policy on the Worker; dependency CVE scan; a JWT/JWKS rotation drill; rate-limit tuning against realistic abuse — specifically **whether a free-tier account can drive hosting cost through sandbox creation or the SSE `/events` endpoint before entitlement checks apply.**

**DoD:** each item has a written finding and a fix-or-accept decision; the abuse question is answered by an actual attempt against staging, not by reading the code; any rate limit changed is tripwired.
**Depends on:** C3.

#### F5 — Backup and disaster recovery — **S–M** — ⏸ DEFERRED (owner: "leave all after F4")
**Why:** *Also a critic catch — outside all five audit areas.* Claxedo Cloud stores customer workspace, session, and billing state in Convex and document bytes in R2. Repo-wide grep for backup/DR/retention finds exactly one hit, in a design doc. Losing a user's workspace is trust-destroying regardless of price tier.

Tasks: confirm Convex point-in-time recovery for the production deployment; configure R2 bucket versioning/lifecycle on `claxedo-documents`; write and **actually execute** a restore procedure once.

**DoD:** a documented restore runbook that has been run end-to-end at least once against staging data, with the recovered state verified — not a procedure that has only been written.
**Depends on:** F1.

#### F6 — Launch-day safety checklist — **S** — ⏸ DEFERRED (owner: "leave all after F4")
**Why:** Small items that are cheap now and expensive on launch day.

Tasks: audit production Convex for any org seeded `plan='pro'` during testing (would silently grant paid entitlements); confirm `CLAXEDO_SENTRY_DSN` is provisioned for the production worker/server/relay (absent DSN is a *silent* no-op by design); confirm PostHog keys for the production app build — note the frontend has **no Sentry at all** by deliberate design (`analytics.ts:43` replaces it), so PostHog is the sole frontend crash-visibility path and must be configured *and watched*.

**DoD:** no non-test org has `plan='pro'` in production; a deliberately-triggered test error reaches the Sentry dashboard (server) and the PostHog dashboard (app).
**Depends on:** F1.

#### F7 — Confirm persistent cloud workspaces status — **S** — ⏸ DEFERRED (owner: "leave all after F4"; caution in §0.3 stands)
**Why:** `2026-07-23-002` reads as a complete design (U1–U5, exact files named) with **no implementation evidence found**. Cloud workspace durability is a headline capability claim. If it isn't built, the website should not imply it.

Tasks: check for `packages/sandbox-manager/src/drivers/exe.ts`, `workspace-runtime/src/worktree.ts`, and the `SandboxLease` checkpoint fields; if unimplemented, adjust launch copy to describe Cloud workspaces as ephemeral.

**DoD:** a file-by-file status table against U1–U5 marking each built/partial/not-started; website copy matches the answer.
**Depends on:** nothing.

---

## 5. Explicitly deferred to post-launch

- **Effect ecosystem bump (beta.83 → beta.102+).** 19 betas of prerelease API churn, a patch to regenerate, ~13 consuming packages to re-verify. There is no version-currency requirement forcing this before a free launch, and attempting a 19-beta prerelease jump under launch pressure is itself a launch risk. **When it is done**, it must also cover `packages/claxedo-app/package.json:151`, which independently pins `effect@4.0.0-beta.66` — 17 betas older than the catalog and outside the patch entirely. Every audit of "the effect pin" missed this; the critic found it.
- **vite (1 major behind) and astro (2 majors behind).** Each needs its own scoped investigation.
- **WorkGraph v2** (`2026-07-18-004/005`), **CF hardening W6** (multi-instance Node/Convex coordination, blocked on Convex functions not being in this checkout), **`claxedo up` CLI**, **channels layer**. All real work, none of it gating a free public launch.
- **LICENSE attribution.** All 12 public packages ship `Copyright (c) 2025 opencode`. Cosmetic, visible to every npm consumer, not a blocker.
- **`@claxedo/mcp` has no root export** — almost certainly intentional (it's a binary), but undocumented, inviting a future "fix."
- **Dead duplicate patch file** `patches/@floating-ui+utils+0.2.10.patch` (the live one is the `@`-named variant).

---

## 6. Ordering and parallelization map (normative)

```
A1  Get origin/dev green ─────────────────────────────────────┐
                                                              │
   ┌──────────────────────────────────────────────────────────┤
   │                                                          │
   ▼                          ▼              ▼                ▼
  E1 Wire tests into CI      D1 Republish   D4 Safe bumps    F2 Desktop release
   │                          │             F3 Onboarding
   ▼                          ▼
  E2 Convex isolation        D2 Publish automation
  E3 Route tests (also standalone)
  E4 Live e2e tier

C1 Rewrite prompt ──▶ C2 Repo affordance
        │
        └──▶ C3 First staging deploy ──▶ F1 Production env ──▶ F5 Backup/DR
                     │                          └──▶ F6 Launch checklist
                     ├──▶ D3 CF tooling currency
                     └──▶ F4 Security review

§7 owner decisions ──▶ B6 Docs deploy ──▶ B2 Canonical surface ──▶ B4 Cloud docs
                                                 └──▶ B5 Feature backfill

Independent, start anytime: B1 (AGENTS.md), B3 (links), D5 (pnpm-workspace), F7 (workspace status)
```

**Start immediately and in parallel — nothing blocks these:** A1, C1, B1, B3, D5, F7, and drafting E3's tests.

**Two edges the auditors missed** (added by the critic, both real): E1 and F1 both silently assumed a green `origin/dev`. Turning on a stricter CI gate while the existing one is red makes pre-existing and new failures indistinguishable; promoting to a brand-new production environment on a red build ships the known e2e regressions. Both now depend on A1.

**The critical path to launch** is: `A1 → C3 → F1 → F5/F6`. Everything else parallelizes around it.

**Suggested agent fan-out:** Group B (docs) and Group C (prompt) touch disjoint files and can run as separate agents concurrently. Group D and Group E both touch `package.json`/`turbo.json` — serialize or use worktrees. Group F is mostly owner-gated ops, not agent work.

---

## 7. Decisions only the owner can make

These block real streams. None can be resolved from the code:

1. **Who owns hosting/edge for `claxedo.com` and `docs.claxedo.com`?** `redirects.json` is explicitly `"unbound"` pending this. **Blocks B6, and B6 blocks all remaining doc work.**
2. **Who owns analytics, and which provider?** Named in the website plan as a hard prerequisite for deployed verification.
3. **Is `public-docs/` an internal ops tree or a public source?** Blocks B2, which blocks B4 and B5.
4. **What happens to draft releases `v0.0.60/61/62`?** Delete, finish, or supersede — needed before F2 cuts a new one.
5. **Ship onboarding v1 behind the flag, or launch on the legacy setup card?** Depends on F3's verification result.
6. **Is Cloud workspace persistence claimed at launch?** If F7 finds U1–U5 unbuilt, marketing copy must change.

---

## 8. What this document does not claim

- It does not claim the streams are sufficient. The audits covered docs, the deploy prompt, npm, Cloud tests, and cross-cutting blockers; a completeness critic then swept for gaps and found three (backup/DR, security review, the claxedo-app effect pin). There may be more.
- It does not claim the estimates are reliable. They are relative sizes from a read-only sweep, not costed plans.
- Anything marked **unverified** above — notably F3's defect status and F7's implementation status — is a task, not a finding. Do not treat it as either confirmed or refuted.
