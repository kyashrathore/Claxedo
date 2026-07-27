# Doc retention triage: what is safe to delete, and what is not

- **Date:** 2026-07-27
- **Status:** RECOMMENDATION — nothing deleted by this pass
- **Scope:** all 74 files in `docs/plans/`, plus `docs/brainstorms/`, `docs/decisions/`, `docs/tech-docs/`, `docs/plans/evidence/`, the loose `docs/*.md`, and `growth/`. 94 items total.
- **Method:** mechanical reference scan (which docs are cited by source, tests, CI, or package READMEs — separated from docs-citing-docs, which is much weaker evidence), then eight batched reviewers reading the actual documents and checking each doc's claims against current code, then an adversarial critic auditing every DELETE verdict. Two verdicts were overturned; both are flagged below.

---

## The rule being applied

`docs/plans/README.md` already states it:

> Delete completed plans when they no longer provide a maintained implementation, deployment, testing, or package-boundary reference.

### The framing that makes this decidable

**Everything here stays in git history.** Deleting a file from the working tree destroys nothing — `git log --diff-filter=D -- <path>` then `git show <sha>^:<path>` brings it back. So the question is never "is this valuable?" It is:

> **Would someone need to find this without already knowing it exists?**

That splits cleanly:

- **A decision with rationale — especially a rejected alternative** → keep. Someone *will* propose the rejected thing again, and they will not think to search deleted git history for why it was rejected.
- **An implementation plan whose work shipped** → delete. The code is the truth now. A stale second description of shipped code can only drift and mislead.
- **An inventory / move-map / fix-map / handoff** → delete. Scaffolding for a migration that already happened.
- **A doc a source file names** → keep, or edit that source comment first. Never orphan a code pointer.

**One caveat on motivation:** if the goal is repo size, this won't deliver. `.git` is 603M; the 2.8M of evidence binaries live there permanently whether or not you delete them from the working tree. Deleting is worth doing for *clarity* — fewer stale docs contradicting the code — not for disk.

---

## Summary

| Verdict | Count |
|---|---|
| **DELETE-SAFE** — remove now, nothing lost | **26** |
| **DELETE-AFTER-EXTRACTION** — salvage one specific thing first | **7** |
| KEEP — code/test/CI/README cites it by name | 29 |
| KEEP — decision or rejected alternative not recoverable from code | 15 |
| KEEP — work not finished | 17 |

**33 of 94 can go — about a third.**

---

## Safe to delete now (26)

Nothing in these is unrecoverable from current code plus git history. All paths relative to `docs/plans/` unless shown otherwise.

**Superseded app-refactor scaffolding** — these describe a `claxedo-ui/` + `session-client/` layout that **no longer exists**; the reorg landed differently as `src/app|features|ui|platform|lib`, so the move-maps are unusable against current paths:
```
2026-07-11-001-wave-minus1-commit-plan.md
2026-07-11-003-wp-d5-workspace-directory-split-design.md
2026-07-11-005-wp-d1-session-consolidation-move-map.md
2026-07-11-007-wp-d3-utils-dissolution-move-map.md
2026-07-11-009-wp-c1-a11y-fix-map.md
2026-07-10-001-refactor-claxedo-app-oss-quality-hld.md
2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md
2026-07-10-004-claxedo-app-org-review-appendix.md
2026-07-10-005-goal-execute-claxedo-app-oss-quality.md
```
Two of these are now enforced by live code guards that carry the rationale inline — `src/architecture/directory-named-workspace.ts` for the workspaceId/directory split, and `e2e/playwright/a11y-baseline.json` + `a11y-sweep.spec.ts` (shrink-only) for the a11y map. The guard is a better record than the doc.

**Shipped features** — the code is the description now:
```
2026-07-12-002-feat-pi-provider-model-selection-plan.md
2026-07-12-003-feat-sticky-workspace-harness-defaults-plan.md
2026-07-12-004-feat-sidebar-account-menu-plan.md
2026-07-15-001-fix-pages-filesystem-documents-plan.md
2026-07-16-001-feat-documents-core-implementation-plan.md
2026-07-17-002-feat-onboarding-v1-implementation-plan.md
2026-07-17-003-fix-documents-notion-editor-recovery-plan.md
2026-07-06-004-refactor-workgraph-flat-inbox-oss-plan.md
2026-07-16-003-workgraph-staging-debug-handoff.md
2026-07-17-001-feat-workgraph-event-driven-settlement-plan.md
2026-07-23-001-feat-local-performance-diagnostics-plan.md
2026-07-23-002-feat-persistent-cloud-workspaces-plan.md
2026-07-12-001-subscription-launch-adversarial-review.md
docs/brainstorms/2026-07-16-claxedo-documents-core-requirements.md
docs/tech-docs/ai-infra/README.md
```

**Codex theme (2 files) — verify before deleting:**
```
2026-07-26-001-refactor-codex-theme-clean-transplant-plan.md
2026-07-27-001-port-codex-theme-transplant.md
```
The work merged to `dev` (`2446d9fc5 Merge the Codex theme transplant onto dev` plus follow-up fixes), so DELETE is defensible. **But two things conflict with that:** `docs/plans/README.md` still lists `2026-07-26-001` as a retained active plan, and `2026-07-27-001` self-declares `IN PROGRESS`. Confirm the transplant is actually finished before removing these, and edit the README either way.

### Three notes on this list

- **`2026-07-23-002-feat-persistent-cloud-workspaces-plan.md`** was flagged in the launch-streams doc as a plan with *no implementation evidence*. If that's still true, this is a plan for **unbuilt** work and should be KEEP-ACTIVE, not deleted. Resolve that first — it's stream F7 in `2026-07-27-002`.
- **`docs/tech-docs/ai-infra/README.md`** justifies its own retention by claiming `packages/claxedo-app/src/overrides/README.md` links to it. That directory **was deleted** — the justification is dead, and each package's own README covers the same ground.
- **`2026-07-16-001-feat-documents-core-implementation-plan.md`** is 1067 lines, the largest single deletion. Its decisions survive in `docs/decisions/2026-07-16-*.md` and `2026-07-17-*.md`, which are all KEEP.

---

## Delete after extracting one thing (7)

Each is mostly stale but holds a specific nugget that would be painful to re-derive. Move the nugget, then delete.

| File | Extract | Destination |
|---|---|---|
| `2026-07-11-003-e2e-effort-final-report.md` | The five **operational lessons**: Tier M mocked e2e needs `bun run dev`, never `vite preview` (DEV-only seams get dead-code-eliminated, costing false regressions); cap ~3 concurrent Playwright suites; SSE mocks need per-connection broadcast, not drain-once queues; Playwright `page.route` matching is LIFO; a shared git index means bare `git commit` sweeps other agents' staged files. | a "Testing gotchas" section in `packages/claxedo-app/e2e/INVARIANTS.md` |
| `2026-07-11-008-wp-d4-package-scope-rename-inventory.md` | The recorded decision that `@claxedo/app` (de-stuttered) was chosen over `@claxedo/claxedo-app`, with the directory/package-name mismatch **accepted as cosmetic**. Nothing in code explains this; someone will propose "fixing" it. | the "Package scope" section of `packages/claxedo-app/src/VOCABULARY.md` |
| `2026-07-10-004-feat-connection-scoping-team-personal-plan.md` | Why session-id-based credential resolution was **rejected** (forgeable/guessable; a wake-fired turn could spend a user's personal token) and the fail-safe invariant: a propagation bug degrades to "personal connection unused", never "personal token spent by automation". | "Security Gates" in `2026-07-03-004-feat-connections-framework-plan.md` (already KEEP) |
| `2026-07-16-005-feat-onboarding-product-and-ux.md` | Four design rationales: funnel-leak reasoning, why remote-access-as-education failed, the Ramp-2 pull-not-push strategy, self-host signed-in trust motivation. | a "Design rationale" section in `packages/claxedo-app/src/features/onboarding/AGENTS.md` |
| `docs/brainstorms/2026-07-16-claxedo-onboarding-journey.md` | (a) The **segment backlog** — CLI/TUI-first onboarding, "import from opencode" `auth.json` migration, GitLab/private-git, Windows discovery gaps. Nothing tracks these. (b) The provider-credential tenancy gap — **see the note below**. | `docs/known-issues.md` |
| `docs/brainstorms/2026-07-21-claxedo-homepage-copy.md` | The **banned-phrase list** ("Start here", "workspace host", "More than another chat window", …) plus the non-fabrication rules (no testimonials, no customer logos, no fabricated metrics). Rejected copy isn't recorded anywhere else. | `2026-07-20-001-feat-claxedo-website-strategy-plan.md` (already KEEP) or `packages/claxedo-web`'s AGENTS.md |
| `docs/plans/evidence/` | Only `2026-07-25-composer-v2-resync-procedure.md` — it is **not evidence**, it's a living runbook with a vendor-point table that must be appended to on every future re-sync, and the composer-v2 migration is unfinished. | move up to `docs/plans/` proper |

> **Independent corroboration worth noting.** That onboarding brainstorm records a provider-credential tenancy gap — `storage/provider-credential.sql.ts` has no org or user column. The security review reached the *same* finding from a completely different direction and rated it **high** (self-host multi-org mode lets any signed-in user read, overwrite, or force-verify another org's provider credentials). Two independent passes landing on the same defect raises confidence considerably. See `2026-07-27-003-claxedo-cloud-security-review.md` §6.

---

## Cannot delete without editing code first (29)

A source file, test, CI workflow, or package README names each of these. Deleting one orphans a pointer someone will later follow.

| Doc | Cited by |
|---|---|
| `2026-07-03-004-feat-connections-framework-plan.md` | `claxedo-server/src/server.ts` |
| `2026-07-07-006-feat-wakes.md`, `2026-07-17-002-feat-wakes-v2-settlement-plan.md` | `packages/wakes/README.md` |
| `2026-07-10-001-refactor-e2e-20-spec-consolidation-plan.md` | `claxedo-app/e2e/INVARIANTS.md` |
| `2026-07-10-003-claxedo-app-audit-findings-appendix.md` | `mobile-smoke.spec.ts`, `a11y-sweep.spec.ts` |
| `2026-07-11-002-fixme-ledger-wp-reconciliation.md` | `core-panes-split-tabs.spec.ts:1086` |
| `2026-07-11-004-wp-c3-workbench-collapse-design.md` | `workbench/collapse-projection.ts:6` |
| `2026-07-11-010-wp-c3-breakpoint-inventory.md` | `ui/controls/breakpoints.ts` |
| `2026-07-11-011-wp-c3-touch-dnd-decision.md` | `workbench/pointer-drag.ts` |
| `2026-07-11-012-feat-cloud-subscription-launch-plan.md` | `claxedo-web/src/content/claims.ts`, `deployment-mode.ts`, `convex/billing.ts` |
| `2026-07-11-015-wp-tenant-hardening-design.md` | `control-plane/deployment-mode.ts` |
| `2026-07-11-016-wp-ops-floor-design.md` | `observability/{node,report,sentry-config}.ts`, `workspace-relay/src/main.ts` |
| `2026-07-12-001-refactor-claxedo-app-directory-architecture-plan.md` | `src/ui/controls/README.md` — **overturned, see below** |
| `2026-07-11-006-wp-c2-keyboard-binding-inventory.md` | `architecture/keybind-collisions.guard.test.ts:10` — **overturned, see below** |
| `2026-07-13-001-goal-execute-workgraph-end-to-end.md` | `packages/workgraph/TASKS.md` |
| `2026-07-17-005-relay-cf-reevaluation.md` | `workspace-relay/src/worker-h2.ts`, `bench/RUNBOOK.md`, `bench/loadgen.ts` |
| `2026-07-25-002-feat-onboarding-full-page-setup-plan.md` | `credentials/verify.ts` |
| `docs/tech-docs/architecture-direction-flow.md` | `features/session/submit/create-with-lifecycle.ts:6` |
| `docs/tech-docs/claxedo-app-performance-budgets.md` | **a test asserts on its literal text** — `workspace-runtime-route-audit.test.ts:250-265` |
| `docs/tech-docs/claxedo-server-worker-deployment-plan.md` | `src/worker.ts:8`, `architecture.test.ts:989`, `wrangler.toml:5` |
| `docs/tech-docs/convex-schema-evolution.md` | `convex/{schema,migrations,convex.config}.ts` |
| `docs/tech-docs/cloudflare-relay-evaluation.md` | `workspace-relay/bench/{mint-htt,loadgen,lib/stats}.ts` |
| `docs/tech-docs/{claxedo-up-cli-plan,identity-roles-auth-foundation}.md` | `public-docs/hosted-control-plane-worker.md` |
| `docs/e2e-decisions.md` | cited **by entry number** from `core-composer-modes.spec.ts`, `documents-core.spec.ts`, `project-actions.test.ts` |
| `growth/star-audience/README.md` | it's the README for live scripts in the same directory |

`claxedo-app-performance-budgets.md` is the strictest: a test reads the file and asserts on strings inside it. Deleting it **fails the test outright**.

### The two overturned verdicts — and a live bug

The critic reversed two DELETE-SAFE calls. The second one matters beyond bookkeeping.

**`2026-07-11-006-wp-c2-keyboard-binding-inventory.md`** was marked DELETE-SAFE. It is cited by `architecture/keybind-collisions.guard.test.ts:10` — a citation my mechanical scan missed. More importantly, the critic checked whether the doc's findings were actually fixed, and one **is not**. I verified it directly:

```
packages/claxedo-desktop/src/main/menu.ts:47  → trigger("claxedo.split.toggle")   → 0 definitions in claxedo-app/src
packages/claxedo-desktop/src/main/menu.ts:48  → trigger("claxedo.tab.close")      → 0 definitions in claxedo-app/src
```

**Cmd+\ and Cmd+W in the native macOS menu are dead** — they dispatch command ids that don't exist. The real ids are `claxedo.split.focusLeft/Right` and `tab.close`. The `claxedo-app` guard test can't catch this because `claxedo-desktop` is a separate package outside its scope. This doc is the only record of the bug and its fix recipe. **Worth filing separately from the deletion work.**

**`2026-07-12-001-refactor-claxedo-app-directory-architecture-plan.md`** — cited from the History section of `src/ui/controls/README.md`, a file contributors actively read when adding components.

---

## Keep — decisions and rejected alternatives (15)

These record *why*, which no amount of reading current code recovers:

```
2026-07-11-013-wp-auth-better-auth-migration-design.md
2026-07-11-014-wp-billing-polar-subscription-design.md
2026-07-10-005-feat-orphaned-connection-deletion-plan.md
2026-07-16-002-feat-documents-core-architecture-and-features.md
2026-07-17-001-review-remote-desktop-access-feasibility.md      <- rejected "expose the whole local app"
2026-07-18-004-feat-workgraph-execution-shape-intake-trust-plan.md
2026-07-18-005-feat-workgraph-v2-implementation-plan.md
docs/brainstorms/2026-07-11-claxedo-positioning-competitors-handoff.md   <- banned-claims list
docs/brainstorms/2026-07-17-documents-rich-mode-gate-investigation.md
docs/decisions/2026-07-16-documents-hosted-object-storage.md
docs/decisions/2026-07-16-documents-session-writeback.md
docs/decisions/2026-07-17-documents-core-implementation-answers.md
docs/tech-docs/pi-permission-flow.html
docs/deployment-feasibility-2026-07-22.md
docs/local-diagnostics-dependency-review.md
```

`pi-permission-flow.html` deserves a specific mention: it documents that pi's permission gate is a **regex match on a literal `permission:` prefix in prompt text** — not real tool interception — and that its default sandbox is a virtual in-memory bash. That is a surprising, security-relevant finding that took deep tracing to establish and is summarized nowhere else.

## Keep — work not finished (17)

```
2026-07-06-005, 2026-07-07-002, 2026-07-09-001, 2026-07-18-001, 2026-07-18-002,
2026-07-20-001, 2026-07-21-001, 2026-07-22-001, 2026-07-22-002, 2026-07-22-003,
2026-07-25-001, 2026-07-25-003, 2026-07-25-004, 2026-07-25-005,
2026-07-27-001-mock-runtime-response-contracts, 2026-07-27-004-feat-universal-sandbox-checkpoints,
docs/known-issues.md
```
Plus today's three: `2026-07-27-002` (launch streams), `-003` (security review), `-004` (tracking review).

---

## `docs/plans/evidence/` — a separate problem

2.8M, 59 git-tracked files: 34 PNGs, 19 `.webm` videos, 4 md, 2 json. One-time proof-of-work artifacts for shipped features.

Two things make this its own case:

1. **It is a checked-in test output directory.** `e2e/playwright/core-boot-deep-links-home.spec.ts:443,448,559` *writes* screenshots into `docs/plans/evidence/`. Those files regenerate on every run — checking them in means the test dirties the working tree. Consider pointing that output at a gitignored path.
2. **Deleting it saves no repo space.** The binaries are already permanent in the 603M `.git`. This is a working-tree-cleanliness change only.

Salvage `2026-07-25-composer-v2-resync-procedure.md` (a live runbook for the unfinished composer-v2 migration), then the rest can go.

---

## Suggested order

1. **Resolve the three flagged conflicts first** — persistent-cloud-workspaces (built or not?), the two codex-theme docs (transplant finished?), and whether `evidence/` screenshots should be gitignored.
2. **Do the 7 extractions.** This is the only genuinely irreversible-in-practice step, because after deletion nobody will know to look for what was lost.
3. **Delete the 26.** Straight `git rm`.
4. **Update `docs/plans/README.md`** — its Retained list references docs that are going away, and it will otherwise carry dangling links.
5. **File the desktop-menu keybinding bug separately** so it doesn't get lost with the doc.

Steps 2–4 should land as **one commit**, so the extraction and the deletion are never separated in history — and use `git commit --only <paths>`, since a shared index has previously swept other agents' staged files into a commit.

---

## Confidence and limits

- Reference data is mechanical and reliable for *exact filename* citations. The critic found one citation it missed (`keybind-collisions.guard.test.ts` cites `docs/plans/2026-07-11-006` — a **truncated** path, without the full filename). Other truncated-form citations may exist. Before deleting any file, a `grep -rn "<the plan's date-and-number prefix>"` is a cheap final check.
- Reviewers verified doc claims against code, but "is this feature shipped?" was judged from source reading, not by running anything.
- Only DELETE verdicts were adversarially audited. KEEP verdicts got one pass, so this list may still be slightly over-cautious — if you want to cut deeper, the KEEP-DECISION group is where to look next.
