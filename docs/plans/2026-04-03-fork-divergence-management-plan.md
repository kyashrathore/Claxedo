---
date: 2026-04-03
topic: fork-divergence-management
status: active
origin: chat
---

# Fork Divergence Management Plan

## Goal

Move Claxedo fork maintenance from "docs + reviewer memory + scattered tests" to a system where intentional divergence is:

- explicitly modeled
- test-backed
- sync-aware
- easy to audit when upstream changes

The target state is not to copy Brave or Debian mechanically. It is to reach the same level of operational discipline while preserving Claxedo's stronger app-level test surface and extension seams.

More specifically, the system should optimize for the surfaces we actually care about:

- the desktop app experience
- the Claxedo-owned behaviors inside that experience
- the component and provider seams that make those behaviors work

The fork itself is not the product. The desktop behavior is the product. Fork-management should serve that.

## Problem Frame

Today the repo already has useful pieces:

- override registry and reasons in [packages/claxedo-app/src/overrides/README.md](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/README.md)
- sync strategy docs in [packages/claxedo-app/.dev-docs/CLAXEDO_UPSTREAM_SYNC.md](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/.dev-docs/CLAXEDO_UPSTREAM_SYNC.md), [ .dev-docs/REBASE_AGENT.md](/Users/yashvardhansingh/test/opencode/.dev-docs/REBASE_AGENT.md), and [ .dev-docs/SYNC_LOG.md](/Users/yashvardhansingh/test/opencode/.dev-docs/SYNC_LOG.md)
- real contract-style tests in [packages/claxedo-app/src/claxedo-ui/context/terminal-contract-harness.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/terminal-contract-harness.test.ts), [packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.contract.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.contract.test.ts), and [packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.contract-ops.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.contract-ops.test.ts)

But the current model still has structural gaps:

- intentional divergence is not a first-class machine-readable artifact
- sync work can merge code without forcing a decision on the affected divergence units
- many tests prove local behavior, but not always the specific reason an override exists
- docs still carry semantic weight that should live in executable contracts

This creates the exact failure modes already seen:

- broken behavior discovered after review
- accidental upstream changes landing silently
- good upstream bug fixes and refactors not being carried over
- high drift becoming expensive to maintain

## Prior Art

This plan borrows principles from two proven downstream-maintenance models:

- Brave Chromium rebases: explicit patch/update workflow, override checks, required build and test gates, and smoke verification
- Debian quilt patch stacks: explicit divergence units, ordered patch metadata, and documented permanent deviations

Relevant references:

- [Brave Chromium rebases](https://github.com/brave/brave-browser/wiki/Chromium-rebases)
- [Debian best practices for patches](https://www.debian.org/doc/manuals/developers-reference/best-pkging-practices.html)
- [quilt(1)](https://manpages.debian.org/bullseye/quilt/quilt.1.en.html)

## Locked Direction

- Claxedo is allowed to stay heavily diverged from upstream.
- The goal is not "minimize diff at all costs."
- The goal is "keep desktop-critical behavior intentional, test-backed, and easy to re-evaluate."
- Product-critical desktop invariants come first.
- Divergence metadata exists only to protect those invariants.
- High-risk divergence that supports desktop-critical behavior must be represented as named units with required contract tests.
- Sync flow must map upstream changes onto those named units before the work is considered complete.
- Docs should become an index into divergence units and tests, not the main place behavior is explained.

## Truth Hierarchy

The plan should be read in this order:

1. **Desktop-critical invariants**
   - what must remain true in the product
2. **Component and provider contracts**
   - which local seams enforce those truths
3. **Divergence units**
   - where upstream and local code differ in order to preserve those truths
4. **Sync process**
   - how upstream change is evaluated against those truths

This is the reverse of a fork-first model.

## Primary Scope

The first pass should focus only on the desktop app surfaces that materially define Claxedo behavior.

In scope:

- app shell/provider composition
- layout and directory layout
- prompt/session creation and embedded-session flows
- terminal lifecycle and multi-pane behavior
- persistence and recovery behavior
- server/platform compatibility behavior needed by the desktop app

Out of scope for the first pass:

- broad cataloging of every override in the repo
- low-risk visual differences
- upstream surfaces that do not materially affect the desktop product path

## Architecture

### 0. Desktop-Critical Invariants

Before talking about fork structure, define what must hold true in the desktop app.

Examples of likely first-class invariants:

- extension and provider composition order remains valid for the desktop shell
- directory-scoped providers remain stable and available where Claxedo expects them
- prompt submission preserves embedded-session semantics
- terminal tabs, pane ownership, attach/recovery, and split behavior remain stable
- persisted local state and migrations do not corrupt or leak across server/workspace boundaries
- server URL compatibility and desktop routing assumptions remain stable

These invariants should drive test architecture. Divergence tracking is secondary.

### 1. Divergence Units

Treat each important override or upstream patch point as a `Divergence Unit`, but only when it exists to preserve a desktop-critical invariant.

Each unit has:

- `id`: stable identifier such as `app.layout-shell` or `prompt.embedded-session`
- `kind`: `override`, `extension-seam`, `upstream-patch`, or `fork-only-module`
- `risk`: `high`, `medium`, or `low`
- `upstream`: canonical upstream file path or seam
- `local`: local file paths that implement the divergence
- `reason`: short product/architecture rationale
- `policy`: `port`, `skip`, `merge`, or `remove` expectation during sync
- `tests`: contract and smoke test file paths that prove the divergence
- `owners`: optional human/area ownership label

This is the core supporting abstraction, not the top-level source of truth.

### 2. Contract-Backed Divergence

For high-risk units, the primary specification is a contract test, not prose.

Contract tests must state:

- what upstream behavior still must hold
- what Claxedo-specific behavior intentionally differs
- what regressions this contract is meant to catch

Good contract tests should survive refactors and fail on behavior drift.

### 3. Component and Provider Contracts

For this repo, many of the right contracts are not "fork contracts" in the abstract. They are contracts around:

- provider wiring
- page-level component composition
- session and terminal state behavior
- persistence and recovery semantics

So the core tests should be written around those product seams first, then linked back to divergence units.

### 4. Sync Impact Mapping

Each sync or targeted carryover should:

1. identify upstream files changed since the last upstream baseline
2. map those files to divergence units
3. run a seam-impact pass for indirect drift on high-risk desktop invariants
4. require one of:
   - existing contract still covers the change
   - contract updated because intent changed
   - divergence removed because upstream now satisfies the need

This is the equivalent of Brave's patch failure and override audit, adapted to a TypeScript app fork.

The seam-impact pass exists to catch the real failure mode that plain file mapping misses:

- changed exports
- changed function signatures
- changed types or required fields
- provider-chain expectations moving into adjacent files
- file extraction, rename, or responsibility shifts that do not touch the exact overridden file

For high-risk invariants, the sync workflow should check both:

- direct file overlap
- indirect seam impact through imports, exported symbols, provider ownership, and known upstream dependency edges

### 5. Docs as Index, Not Source of Truth

Keep docs for:

- registry browsing
- sync policy
- human-readable reasoning

Do not depend on docs alone to preserve behavior.

Behavioral truth should move into:

- contract tests
- sync impact tooling
- machine-readable divergence metadata

## Proposed Implementation Units

### Unit 0. Desktop Invariant Inventory

Create a short source-of-truth inventory of desktop-critical invariants.

Files:

- `packages/claxedo-app/src/contracts/desktop-invariants.ts`
- `packages/claxedo-app/src/contracts/desktop-invariants.test.ts`

Responsibilities:

- define the small set of product truths the fork-management system is protecting
- link each invariant to the component or provider seams that enforce it
- link each invariant to divergence units only where necessary

Key decisions:

- keep this list intentionally small
- optimize for "must hold true" rather than "everything we changed"
- do not model upstream file paths here unless they matter to the invariant

Test scenarios:

- invariant registry is internally consistent
- each invariant points to at least one test-bearing seam
- desktop-critical invariants marked `high` have at least one contract test path

This unit should be implemented before the broader divergence registry.

### Unit 1. Divergence Registry

Create a machine-readable divergence registry.

Files:

- `packages/claxedo-app/src/overrides/contracts/types.ts`
- `packages/claxedo-app/src/overrides/contracts/registry.ts`
- `packages/claxedo-app/src/overrides/contracts/registry.test.ts`

Responsibilities:

- define divergence-unit schema
- register all high-risk divergence units
- link divergence units back to desktop-critical invariants
- validate that registered test paths and local paths exist
- encode sync policy in one place

Key decisions:

- start with high-risk units that protect desktop-critical invariants only; do not inventory every override on day one
- keep the registry in code, not YAML, so it can be typechecked and queried by tools

Test scenarios:

- rejects registry entries missing required fields
- rejects `high` risk entries without contract tests
- rejects missing local or test paths
- allows multiple local files for one divergence unit

### Unit 2. Contract Test Header Convention

Standardize the contract test format.

Files:

- `packages/claxedo-app/src/overrides/contracts/README.md`
- update existing:
  - `packages/claxedo-app/src/claxedo-ui/context/terminal-contract-harness.test.ts`
  - `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.contract.test.ts`
  - `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.contract-ops.test.ts`

Responsibilities:

- define the shape of a contract test header
- make existing contract-like tests conform to one convention
- distinguish `contract` tests from ordinary unit tests
- make the contract clearly state the desktop-critical invariant it protects

Recommended header fields:

- desktop-critical invariant id
- divergence unit id
- upstream seam
- intentional difference
- invariants
- out of scope

Test scenarios:

- not a runtime test unit; success is consistent structure and adoption

### Unit 3. High-Risk Contract Coverage

Create or strengthen contract tests for the highest-risk divergence seams.

Files:

- `packages/claxedo-app/src/overrides/app.contract.test.tsx`
- `packages/claxedo-app/src/overrides/pages/layout.contract.test.tsx`
- `packages/claxedo-app/src/overrides/pages/directory-layout.contract.test.tsx`
- `packages/claxedo-app/src/overrides/context/server.contract.test.tsx`
- `packages/claxedo-app/src/overrides/components/prompt-input.contract.test.tsx`
- `packages/claxedo-app/src/overrides/components/settings-general.contract.test.tsx`
- `packages/claxedo-app/src/overrides/components/status-popover.contract.test.tsx`

Primary implementation files under test:

- `packages/claxedo-app/src/overrides/app.tsx`
- `packages/claxedo-app/src/overrides/pages/layout.tsx`
- `packages/claxedo-app/src/overrides/pages/directory-layout.tsx`
- `packages/claxedo-app/src/overrides/context/server.tsx`
- `packages/claxedo-app/src/overrides/components/prompt-input.tsx`
- `packages/claxedo-app/src/overrides/components/settings-general.tsx`
- `packages/claxedo-app/src/overrides/components/status-popover.tsx`

Decisions with rationale:

- prioritize seams where upstream drift can silently break routing, provider order, session creation, or settings carryover
- do not duplicate existing focused tests like [submit.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/overrides/components/prompt-input/submit.test.ts); wrap them with a higher-level contract where needed
- treat the contract tests as desktop-behavior specs first and override specs second

Test scenarios:

- `app.contract.test.tsx`
  - extension providers still wrap the app in the expected order
  - authenticated providers still compose under the right shell
  - default layout fallback still works when no extension overrides are registered
- `layout.contract.test.tsx`
  - fork layout still preserves Claxedo-owned sidebar/workspace behavior
  - upstream-compatible theme and provider paths still remain reachable
- `directory-layout.contract.test.tsx`
  - directory provider chain remains stable
  - `resolveSessionUrl` auto-switch behavior remains intentional
  - `DataProvider` callbacks still route through Claxedo expectations
- `server.contract.test.tsx`
  - URL transform and server key behavior remain compatible with fork expectations
  - upstream-compatible connections still work through the same contract
- `prompt-input.contract.test.tsx`
  - embedded session creation rules remain intentional
  - `sessionID`, `navigateOnCreate`, `system`, and `agent` semantics stay intact
  - upstream carryovers do not remove fork-specific draft/session behavior
- `settings-general.contract.test.tsx`
  - upstream settings rows can be carried over without dropping fork-owned sections
- `status-popover.contract.test.tsx`
  - server selector mode and default-server compatibility remain stable

### Unit 4. Sync Impact Tooling

Add tooling that maps upstream changes to divergence units.

Files:

- `packages/claxedo-app/script/divergence-impact.ts`
- `packages/claxedo-app/script/divergence-impact.test.ts`

Responsibilities:

- read previous upstream SHA and target upstream SHA
- compute changed upstream files
- map changed files to registered divergence units
- report the desktop-critical invariants that may be affected
- run a reverse-dependency and seam-ownership pass for high-risk invariants
- print a compact report:
  - changed unit ids
  - affected invariant ids
  - risk level
  - required test files
  - sync policy

Key decisions:

- this should be a reporting and gating tool, not an auto-merger
- tool output should be brief enough to use during every sync
- start with an explicit seam map for high-risk invariants before attempting any broader dependency inference

High-risk seam map should support at least:

- upstream file path -> divergence unit
- upstream exported module -> divergence unit
- provider/composition seam -> divergence unit
- known "adjacent drift" files that historically break the same invariant

Test scenarios:

- maps direct upstream file changes to registered units
- maps shared seam changes such as `packages/app-shared/src/extension-points.ts` to dependent units
- flags changed exported symbols or provider seams that affect a high-risk invariant even when the overridden file itself did not change
- reports unregistered touched high-risk override pairs as warnings

### Unit 5. Sync Gate Integration

Integrate divergence checks into the sync workflow.

Files:

- update `packages/claxedo-app/package.json`
- update `.dev-docs/REBASE_AGENT.md`
- update `.dev-docs/DAILY_UPSTREAM_SYNC_PLAYBOOK.md`
- update `.dev-docs/SYNC_LOG.md`

Responsibilities:

- add a script such as `bun run --cwd packages/claxedo-app divergence:impact`
- require sync notes to reference divergence unit ids instead of free-form file notes only
- require high-risk touched units to have a contract decision recorded

Test scenarios:

- documentation/process change only; validation comes from manual dry-runs on one targeted carryover and one full rebase

### Unit 6. Override Index Refresh

Make override docs point at the registry and tests.

Files:

- update `packages/claxedo-app/src/overrides/README.md`
- update `packages/claxedo-app/.dev-docs/CLAXEDO_UPSTREAM_SYNC.md`

Responsibilities:

- shrink duplicate prose
- point each high-risk unit to:
  - registry id
  - upstream seam
  - contract tests
- keep low-risk override docs lightweight

Test scenarios:

- documentation/process change only

## Risk Tiers

### High

These should have explicit divergence-unit entries and contract tests:

- app shell/provider wiring
- directory provider chain
- prompt/session creation semantics
- terminal lifecycle and ownership
- layout/group/worktree state
- persistence and migration behavior
- server/platform compatibility shims

### Medium

These should have focused tests and registry entries when behavior is intentional:

- settings extensions
- status popover behavior
- home page server selector mode
- session view-state stabilizers

### Low

These can stay as manifest-only unless they prove fragile:

- mostly cosmetic overrides
- copy/layout tweaks without behavioral branching
- files already fully covered by adjacent high-level contracts

## Execution Posture

Characterization-first and product-first.

Do not start by rewriting overrides. Start by:

1. naming desktop-critical invariants
2. strengthening contracts around existing behavior
3. naming divergence units only where those invariants depend on divergence
4. adding sync impact tooling
5. only then simplifying or deleting divergence that becomes unnecessary

This keeps the migration safe and aligns with the goal that tests should document intentional behavior.

## Recommended Order

1. Desktop invariant inventory
2. Contract coverage for one or two pilot desktop-critical seams
3. Divergence registry
4. Contract test convention
5. Contract coverage for the remaining highest-risk seams
6. Sync impact tool
7. Sync docs and package script integration
8. README and registry cleanup
9. Expand medium-risk coverage only after the core loop works

## Success Criteria

- Every high-risk divergence is represented by a named divergence unit.
- Every desktop-critical invariant is represented explicitly.
- Every high-risk divergence unit points to at least one contract test.
- Every high-risk desktop-critical invariant points to at least one contract-bearing seam.
- Sync work can enumerate which divergence units were affected by upstream changes.
- Sync work can enumerate which desktop-critical invariants may have been affected by upstream changes.
- Sync work can surface indirect seam drift for high-risk invariants, not only direct file overlap.
- Sync logs record decisions in terms of divergence units, not only ad-hoc file notes.
- A maintainer can answer:
  - what product truth this code protects
  - why this override exists
  - what behavior it guarantees
  - what tests prove it
  - what to do when upstream changes the seam
- At least one targeted carryover and one broader sync can run through the new flow without adding obvious process thrash.
- Post-sync review should require fewer ad-hoc file-by-file audits for covered high-risk seams.
- The system should reduce, not merely relabel, the known failure modes:
  - missed upstream carryovers
  - breakage discovered after review
  - unnoticed semantic drift in dependent seams
- For covered high-risk seams, sync decisions should become more deterministic:
  - explicit `ported`, `skipped`, `deferred`, or `removed`
  - linked to a contract or invariant
- The repo can remain intentionally drifted without making sync work fragile.

## Non-Goals

- Converting every override into an extension point immediately
- Replacing all existing tests with contract tests
- Building a general-purpose patch-stack system like Debian quilt
- Requiring total parity with upstream behavior where Claxedo intentionally differs
- Automating merge decisions that still require product or architecture judgment

## Open Questions

- Should divergence registry ids be grouped by product surface (`layout.*`, `terminal.*`) or by upstream path?
- Should sync impact tooling fail CI for touched high-risk units with missing contracts, or warn first during rollout?
- Which existing end-to-end tests in `packages/claxedo-app/e2e/` should be promoted to parity smoke tests for sync validation?
- Should some current overrides be deliberately re-cut as upstream extension seams before new contract tests are written?

## Immediate Next Deliverables

1. Create desktop invariant inventory
2. Create divergence registry types and first registry file
3. Register the first 8-12 high-risk divergence units tied to those invariants
4. Add contract tests for:
   - `app`
   - `layout`
   - `directory-layout`
   - `prompt-input`
5. Add sync impact reporting script
6. Update sync docs to reference divergence units and affected invariants
