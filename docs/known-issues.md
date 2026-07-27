# Known issues — launch register (2026-07-20)

The accepted, understood defect set at launch. Every entry has a diagnosed
root cause; nothing here is a mystery. Ordered by user impact. When one of
these is fixed, delete its entry.

## Product

### 1. pi harness never auto-selects a model
The harness selector's `picked()` deliberately excludes `pi` from the
bare-id model fallback (`src/features/session/ui/controls/agent-harness-selector.tsx`),
and the composer's model control does not render in pi harness mode — so a
fresh pi draft has no selected model and the first send is deferred
indefinitely. Surfaces as the one permanently red e2e test
(`core-harness-rendering-matrix.spec.ts`, pi behavior 1). Needs a decision
from the selector's author: either give pi a default-model path or define
the intended explicit-selection UI so the spec can drive it. Do not
hot-patch the exclusion; it reads intentional.

### 2. `big-pickle` identity split: placeholder vs house model
The app treats `opencode/big-pickle` as a reserved, never-submittable
placeholder (`isSignedWorkspaceDefaultModel`, owner rule 2026-07-16), while
the vendored engine's model-priority list and most of the test corpus still
treat it as the real house model. The e2e mocks now serve `big-pickle-1` (a
servable id) to respect the app contract, but the split is a latent
inconsistency that deserves a deliberate, codebase-wide reconciliation.

### 3. Recap-era legacy rows on staging Convex
Three launch-eve 500s (snapshot/read/archive, attention) traced to rows
predating the recap removal: `activity.recapDueAt` keys and
`purpose: "recap"` due jobs. The serializers now project/skip these
defensively, but the rows remain. A one-shot migration deleting recap-era
due jobs and stripping stale `activity` keys would also fix the residual
cosmetic issue: attention/master-escalation `total` counts can overcount by
the number of skipped stale entries.

### 4. Desktop release is stale (deliberately deferred at launch)
Download links point at `claxedo-v0.0.59`, built 2026-03-08 — ~4.5 months
behind dev. Additionally the shipped auto-updater channel expects a
`latest.yml` feed arrangement the current release doesn't fully satisfy, so
in-app updates cannot be delivered until the next release is cut properly
(tag push through release-claxedo.yml with the Apple secrets verified).

### 5. ~~No community channel~~ — RESOLVED 2026-07-20
A permanent Discord invite (discord.gg/GC6QagQ8QE, no expiry/limit,
verified via Discord API) is wired into the site footer and the issue
templates alongside GitHub Issues.

### 6. Production environment has never been deployed
The `production` GitHub Environment does not exist, so the promote path has
no required-reviewer gate and no secrets. Staging is fully validated
end-to-end; production needs the environment created, secrets provisioned,
and a first supervised promote.

## Test / CI infrastructure

### 7. Windows CI legs are non-blocking
`bun install` fails on Windows applying the `effect@4.0.0-beta.83` patch
(ENOTEMPTY; oven-sh/bun#28147). The unit(windows) leg runs with
`continue-on-error` for visibility; the e2e windows leg was removed with
the shard restructure. Revisit when the Bun bug is fixed.

### 8. e2e must run against a production build in CI
Cold vite dev transforms on 2-core runners push first navigations past
expect budgets (historically 188 timeout failures / 2.5h). CI sets
`CLAXEDO_E2E_PREBUILT=1` (build + `vite preview`); the suite is sharded
8-way plus a separate workgraph-real job. Do not switch CI back to dev
serving.

### 9. Known flaky tests
- `core-docks.spec.ts` behavior 8 (Dismiss/Escape wizard) occasionally
  times out under load; passes standalone.
- Pre-existing `test.fixme` entries (panes ×5, composer ×3, busy-abort ×1,
  and others) carry in-file root-cause notes; they are skipped, not
  passing.

### 10. Local dev-machine quirk: Gatekeeper kills TS compilers
macOS intermittently SIGKILLs the `tsc`/`tsgo` native binaries (exit 137)
on the primary dev machine. Not a repo issue; re-approve the binaries or
rely on CI/`bunx tsgo` when it occurs.

## Product (onboarding segments and tenancy, carried from the retired
onboarding-journey brainstorm)

### 11. Onboarding segment backlog
The v1 onboarding form is designed around one segment (desktop GUI user
with a fresh setup) and ignores several others, none of which are tracked
anywhere else:
- **CLI/TUI-first dev** — `brew install` → never opens Electron; needs a
  terminal-first first-run (auth, connect, first turn).
- **Existing opencode user** — Discover should offer an explicit, celebrated
  "import from opencode" step that migrates their `auth.json`/config
  wholesale, rather than treating them like a cold start.
- **GitLab/other-git private repo** — no PAT/deploy-key path exists for
  private repos on non-GitHub hosts; a raw private-GitLab URL is a dead end.
- **Windows user** — the opencode discovery path is Unix-path-only (broken
  on Windows), and the app ships on Windows (electron-builder nsis target)
  regardless.

### 12. Provider/sandbox credentials have no org/user partition
`packages/claxedo-server/src/storage/provider-credential.sql.ts` has no
org or user column — the table is keyed on `provider_id` alone with no
tenant scoping, unlike connections (which do have team/personal
scoping). Consequence: an invited second team member cannot have
separately-scoped AI/sandbox provider credentials from the rest of their
org — the "use the team's key, don't redo setup" story is unbuildable for
provider credentials today, and self-host multi-org tenancy of these
secrets needs a real fix before team onboarding ships. The security review
(`docs/plans/2026-07-27-003-claxedo-cloud-security-review.md`, "Hosted vs
self-host" section) independently flags the same table as a live,
self-host-reachable gap: in signed multi-org mode any signed-in user from
any org can list, overwrite, delete, or force-verify another org's
provider credentials, since the gate only checks `auth.mode !== "signed"`
with no per-org scoping.

### 13. Competitor onboarding patterns deliberately not adopted
Recorded so they don't get silently reconsidered: trial credits / free
requests (there is no house model to subsidize, so this would be a dark
pattern here); a "one sign-in and you're running" magic flow (impossible
given Claxedo requires two external accounts — BYO AI keys and BYO
compute — so honest, guided copy is the intended moat instead); a hosted
instant playground (the nearest legal substitute is the demo tour plus
replayed real sessions, offered specifically at the compute sign-up wall).
