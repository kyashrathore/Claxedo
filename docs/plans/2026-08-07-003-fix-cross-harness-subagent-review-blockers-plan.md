---
title: "fix: Resolve cross-harness subagent review blockers"
type: fix
status: completed
date: 2026-08-07
deepened: 2026-08-07
---

# fix: Resolve cross-harness subagent review blockers

## Overview

Close the seven actionable findings and one verification gap from the cross-harness subagent code review. The implementation preserves one authoritative subagent identity across late provider binding, always hydrates the durable host snapshot, deletes central metadata trees atomically, confines Cursor transcript registration to Cursor’s canonical project transcript root, renders only host-owned associations, and gives mouse and keyboard users identical child-pane behavior.

The governing contract is:

> `(parentSessionId, subagentKey)` identifies one host subagent. Provider and child-session identities bind onto that host key over time. The host store is authoritative for associations, lifecycle, and transcript resolution; consumers do not repair missing producer data with synthesized cards, chips, identities, statuses, or events.

## Problem Frame

The review reports three high-priority and four moderate defects:

| ID | Priority | Contract failure |
|---|---|---|
| F1 | P1 | Claude’s provider-kind-only observation and later `agentId` observation resolve to different host keys. |
| F2 | P1 | A partial live upsert marks a parent durably loaded and can suppress the complete host snapshot. |
| F3 | P1 | Central parent deletion removes the runtime tree but leaves separately persisted descendant metadata discoverable. |
| F4 | P2 | Production Cursor wiring authorizes the whole workspace rather than the provider’s project transcript root. |
| F5 | P2 | Cards and chips synthesize associations/status from tool metadata or state when the host association is absent. |
| F6 | P2 | Interaction-card lookup uses `subagentKey` globally and can focus another parent timeline. |
| F7 | P2 | Mouse opens the dedicated child pane, while Enter/Space follows ordinary session navigation. |

The review also identifies a verification gap:

| ID | Requirement gap |
|---|---|
| V1 | Claude forwarding limits are asserted with hand-authored counters/text instead of measuring frames emitted through the real SDK ingestion path. |

## Requirements Trace

- **R1 — Stable late-bound identity:** A Claude spawn observed with `providerKind` and no `providerId` retains its original `subagentKey` when `providerId` arrives later.
- **R2 — Immutable binding safety:** A late binding may fill an absent value but cannot replace an incompatible provider kind, provider ID, or child-session ID.
- **R3 — Durable hydration:** Live registry activity and completed durable hydration are tracked separately. Every unresolved parent receives one complete host snapshot; concurrent callers deduplicate that request.
- **R4 — Recursive central deletion:** Deleting a central parent transactionally removes metadata, tags, and attachments for the complete descendant tree while preserving unrelated sessions.
- **R5 — Cursor transcript confinement:** Production Cursor registration resolves only under `<cursor-data-root>/projects/<canonical-workspace-slug>/agent-transcripts`, honoring `CURSOR_DATA_DIR` and otherwise using Cursor’s default data directory.
- **R6 — Authoritative rendering:** Task cards and chips derive only from `resolveSubagents(parentSessionId, toolCallId)`. An absent association renders no synthesized subagent surface.
- **R7 — Scoped interaction focus:** Interaction lookup uses both `parentSessionId` and `subagentKey`.
- **R8 — Input parity:** Mouse, Enter, and Space dispatch the same cancelable open-subagent event and therefore use the same pane placement and focus restoration path.
- **R9 — Real forwarding measurement:** Claude volume assertions count frames and bytes produced through `ingestClaudeSdkMessage` using representative parent and child messages.
- **R10 — End-to-end proof:** Focused package tests and the deterministic browser matrix cover late binding, hydration, deletion, transcript confinement, absent-association rendering, parent scoping, keyboard parity, and unauthorized transcript access.

## Scope Boundaries

- This plan addresses F1–F7 and V1 only.
- Runtime contract version 4 and the `subagent-updated` event shape remain unchanged.
- Compat projection behavior remains unchanged: subagent lifecycle stays outside OpenCode compatibility events.
- The host key remains `(parentSessionId, subagentKey)`; provider IDs, child-session IDs, labels, and descriptions do not become replacement identities.
- Transcript resolver authorization remains fail-closed. Production wiring supplies the exact provider root; the resolver does not broaden or infer roots.
- Pi and other rails without authoritative subagent associations render no subagent card or chip.
- Unrelated Claxedo App and Session UI full-suite failures are outside this plan.

## Context & Research

### Relevant Code and Patterns

- `packages/agent-sdk-runtime/src/subagent-admission.ts` owns observation correlation, immutable binding, revision assignment, and publication idempotency.
- `packages/agent-sdk-runtime/src/harnesses/claude/driver.ts` is the real Claude SDK ingestion boundary used for forwarding measurement.
- `packages/claxedo-app/src/features/session/subagents/subagent-registry.ts` merges live and durable host rows by revision.
- `packages/claxedo-app/src/features/session/subagents/subagent-presentation.ts` is the sole host-row-to-view projection used by Session UI.
- `packages/claxedo-app/src/app/workbench/context/directory-scope.tsx` initiates durable subagent reads and exposes `resolveSubagents`.
- `packages/claxedo-server/src/session/meta/index.ts` owns central projection metadata, tags, and attachments.
- `packages/workspace-runtime/src/transcript-resolver.ts` already enforces authorized handles, realpath confinement, format, and size constraints.
- `packages/workspace-runtime/src/workspace/cursor-transcript-registrar.test.ts` covers Cursor transcript registration at the runtime boundary.
- `packages/session-ui/src/context/data.tsx` exposes authoritative subagent resolution to cards and chips.
- `packages/claxedo-app/src/features/session/ui/message-timeline.tsx` owns the child-pane open event and focus-return integration.

### Institutional Learnings

No `docs/solutions/` directory exists in this checkout. Repository `AGENTS.md` instructions and the executable host/runtime contracts are the governing local guidance.

### External References

No external research is required. Cursor’s installed SDK/runtime layout and the repository’s production wiring are the relevant sources of truth.

## Key Technical Decisions

1. **Late provider identity enriches an existing association.** When a fully identified observation has one compatible unbound association match, it adopts that host key before creating a deterministic provider-key-based key.
2. **Compatibility is checked before enrichment.** An association with a conflicting provider kind is ineligible; immutable binding checks remain the final guard for provider ID, provider kind, and child-session ID.
3. **Only a successful GET marks durable hydration complete.** Live upserts advance registry state and revision rendering but never mutate the durable-loaded set.
4. **Central metadata deletion follows the persisted parent graph.** The deletion owner enumerates the full descendant closure cycle-safely and removes every owned table in one database transaction.
5. **Cursor root computation mirrors Cursor’s production project layout.** Workspace paths use Cursor’s canonical slug algorithm and resolve beneath `CURSOR_DATA_DIR` or `~/.cursor`, never beneath the workspace checkout.
6. **Association absence remains visible as absence.** Session UI does not infer child identity or lifecycle from tool output, metadata, tool status, title strings, or placeholder keys.
7. **The open event is the shared input boundary.** Card and chip actions dispatch a cancelable bubbling event; the app decides pane placement and focus restoration. Direct navigation remains only the downstream behavior when no app handler owns the event.
8. **Interaction focus is parent-timeline scoped.** The DOM query first selects the parent timeline and then the spawn card for the subagent key.
9. **Performance limits measure production ingestion.** The test sends representative SDK messages through `ingestClaudeSdkMessage`, classifies routed parent/child frames, and sums actual forwarded child text bytes.

## Open Questions

### Resolved During Planning

- **Should a provider-kind-only association be considered unbound?** Yes for provider ID, provided its existing kind is absent or exactly compatible with the arriving kind.
- **Should a live upsert suppress durable hydration?** No. Live ingress is partial by design; durable GET completion is the only loaded signal.
- **Should parent deletion rely on runtime teardown alone?** No. Projection metadata has independent persistence and owns its own transactional cascade.
- **Should Cursor use the workspace as an allowlist convenience?** No. The authorized root is the provider’s canonical project transcript directory.
- **Should a missing association render a disabled placeholder card?** No. The producer contract remains visibly missing and can be diagnosed at its owner.
- **Should keyboard activation call ordinary navigation?** No. It uses the same app-owned open event as pointer activation.

### Deferred to Implementation

- None. The review findings and repository patterns determine the required behavior and ownership boundaries.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
  participant C as "Claude SDK"
  participant A as "Admission store"
  participant H as "Host persistence"
  participant D as "DirectoryScope"
  participant U as "Session UI"
  participant P as "Pane owner"

  C->>A: "spawn: tool edge + provider kind"
  A-->>H: "subagent-updated(key K, pending)"
  C->>A: "completion: same edge + provider ID"
  A-->>H: "subagent-updated(key K, completed, provider ID)"
  D->>H: "GET durable subagent snapshot"
  H-->>D: "complete rows and bindings"
  D-->>U: "resolveSubagents(parent, toolCall)"
  U->>P: "cancelable open-subagent event"
  P-->>U: "open child pane; restore parent-card focus on return"
```

## Implementation Units

- [x] **Unit 1: Preserve Claude identity through late provider binding**

**Goal:** Ensure the real Claude pending → running → late-`agentId` sequence produces one host key and monotonically increasing revisions.

**Requirements:** R1, R2, R9

**Dependencies:** None

**Files:**
- Modify: `packages/agent-sdk-runtime/src/subagent-admission.ts`
- Test: `packages/agent-sdk-runtime/src/subagent-admission.test.ts`
- Modify: `packages/agent-sdk-runtime/src/harnesses/claude/driver.test.ts`
- Reference: `packages/agent-sdk-runtime/src/harnesses/claude/driver.ts`

**Approach:**
- Treat a correlation match with no bound provider ID as eligible for late binding when the stored and arriving provider kinds are compatible.
- Prefer the sole compatible unbound association over minting a provider-derived key when `providerId` first appears.
- Keep ambiguous matches unresolved rather than choosing arbitrarily.
- Retain immutable binding checks after key selection so incompatible late observations fail explicitly.
- Replace disconnected forwarding constants with representative Claude SDK messages passed through the real ingestion function.

**Execution note:** Start with the exact reproduced shape: first observation contains `providerKind: "claude-agent"` and no `providerId`; the later observation contains both.

**Patterns to follow:**
- Parent-scoped association maps and `sole(...)` ambiguity handling in `subagent-admission.ts`
- Existing conflicting immutable binding tests in `subagent-admission.test.ts`
- Parent/child routing classification in `ingestClaudeSdkMessage`

**Test scenarios:**
- **Happy path:** Provider kind arrives first and provider ID later; both events use one `subagentKey` with revisions 1 and 2.
- **Happy path:** Tool edge and stable task ID correlate the late provider binding to the original key.
- **Edge case:** The same tool-call ID under two parent sessions produces distinct host keys.
- **Edge case:** Multiple compatible unbound matches remain ambiguous and do not bind to an arbitrary key.
- **Error path:** A late observation with an incompatible provider kind fails with the immutable binding error and publishes no conflicting update.
- **Error path:** Reusing an observation ID with different content remains rejected.
- **Measurement:** Representative parent and child SDK messages produce measured frame counts with child/parent ratio below 2 and actual forwarded child text below 5 MiB.

**Verification:**
- The real Claude-shaped regression reports one host key, all Agent SDK Runtime tests pass, and the forwarding thresholds are derived from ingested frames rather than constants.

- [x] **Unit 2: Separate live registry activity from durable hydration**

**Goal:** Guarantee one complete durable snapshot is fetched for every unresolved parent even when partial live events arrive first.

**Requirements:** R3

**Dependencies:** Unit 1 establishes stable rows for the host snapshot

**Files:**
- Modify: `packages/claxedo-app/src/app/workbench/context/directory-scope.tsx`
- Test: `packages/claxedo-app/src/app/workbench/context/directory-scope.vitest.tsx`
- Reference: `packages/claxedo-app/src/features/session/subagents/subagent-registry.ts`
- Reference: `packages/claxedo-app/src/features/session/subagents/subagent-presentation.ts`

**Approach:**
- Keep independent per-parent sets for durable-load completion and in-flight requests.
- Let live upserts trigger reactive presentation only; they do not mark durable hydration complete.
- Mark a parent loaded only after a successful host response has been parsed and merged.
- Clear loaded state on parent removal or workspace-wide reset; clear only in-flight state after a request settles.
- Preserve revision-aware merge behavior so an older durable row cannot overwrite a newer live field.

**Test scenarios:**
- **Happy path:** First timeline resolution starts one durable GET and hydrates the complete row set.
- **Race:** A partial live upsert arrives before timeline resolution; the later resolution still performs the durable GET and merges missing tool edges/bindings/transcript state.
- **Race:** Two resolutions while GET is pending produce one request.
- **Edge case:** A newer live revision remains authoritative when an older durable row arrives.
- **Error path:** A failed GET does not mark the parent loaded; the next resolution retries.
- **Lifecycle:** Parent removal and workspace reset permit a fresh durable load.

**Verification:**
- DirectoryScope tests prove partial live ingress cannot suppress durable hydration and cannot regress newer live state.

- [x] **Unit 3: Delete central projection metadata recursively and transactionally**

**Goal:** Remove the complete central metadata tree whenever a central parent session is deleted.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `packages/claxedo-server/src/session/meta/index.ts`
- Test: `packages/claxedo-server/src/session/meta/index.test.ts`
- Modify: `packages/claxedo-server/src/session/runtime.ts`
- Test: `packages/claxedo-server/src/session/runtime.test.ts`

**Approach:**
- Build the descendant closure from persisted `parent_id` relationships, starting with the deleted parent.
- Make enumeration cycle-safe and deduplicate every session ID.
- Delete attachments, tags, and metadata rows for the closure inside one transaction.
- Have central runtime deletion call the metadata-tree owner after or within the coordinated runtime teardown path.
- Preserve unrelated roots and descendants exactly.

**Patterns to follow:**
- Central metadata table ownership in `session/meta/index.ts`
- Existing recursive runtime-session teardown in `session/runtime.ts`
- Transactional multi-table mutations already used by the metadata store

**Test scenarios:**
- **Happy path:** Deleting a parent removes parent, child, and grandchild metadata plus their tags and attachments.
- **Edge case:** An unrelated parent and child remain present.
- **Edge case:** A malformed parent cycle terminates and deletes each reachable row once.
- **Edge case:** Deleting a leaf removes only that leaf’s owned rows.
- **Integration:** Central session list and direct read cannot discover any deleted descendant after runtime deletion.
- **Failure path:** A transactional failure leaves the metadata tree intact rather than partially deleted.

**Verification:**
- Server metadata and runtime tests prove no deleted descendant remains discoverable and no unrelated row is changed.

- [x] **Unit 4: Bind production Cursor transcripts to the canonical provider root**

**Goal:** Ensure production registration can only authorize Cursor agent transcripts from Cursor’s project-specific transcript directory.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`
- Test: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts`
- Reference: `packages/workspace-runtime/src/transcript-resolver.ts`
- Test: `packages/workspace-runtime/src/transcript-resolver.test.ts`
- Test: `packages/workspace-runtime/src/workspace/cursor-transcript-registrar.test.ts`

**Approach:**
- Compute Cursor’s project slug with the provider’s production algorithm: replace non-alphanumeric runs, collapse separators, and trim them.
- Resolve the data root from `CURSOR_DATA_DIR` when set, otherwise from the current user’s `~/.cursor` directory.
- Register only the resulting `projects/<slug>/agent-transcripts` directory as the `cursor-agent` transcript root.
- Keep realpath confinement and authorization in the transcript resolver; production wiring supplies the narrow root rather than weakening resolver rules.

**Test scenarios:**
- **Happy path:** A workspace path maps to the exact Cursor project transcript root beneath `CURSOR_DATA_DIR`.
- **Happy path:** With no environment override, the root resolves beneath `~/.cursor/projects/<slug>/agent-transcripts`.
- **Edge case:** Spaces, repeated punctuation, and leading/trailing separators produce the canonical slug.
- **Security:** The computed root does not contain the workspace checkout as a parent.
- **Security:** A valid JSONL file inside the workspace but outside the Cursor root cannot be registered or resolved.
- **Security:** Symlink escape, unauthorized handle, wrong format, and oversized transcript remain rejected by the resolver.
- **Integration:** Embedded production runtime registers and serves a valid transcript from the canonical root.

**Verification:**
- Embedded runtime and Workspace Runtime transcript tests prove exact-root registration and rejection outside it.

- [x] **Unit 5: Render only authoritative associations and unify interaction behavior**

**Goal:** Remove synthesized UI repair and make card/chip mouse and keyboard interactions parent-scoped and behaviorally identical.

**Requirements:** R6, R7, R8

**Dependencies:** Units 1 and 2 ensure the authoritative producer and hydration path are complete

**Files:**
- Modify: `packages/session-ui/src/components/message-part.tsx`
- Modify: `packages/session-ui/src/components/subagent-chip.tsx`
- Test: `packages/session-ui/src/components/message-part.test.ts`
- Reference: `packages/session-ui/src/context/data.tsx`
- Modify: `packages/claxedo-app/src/features/session/ui/message-timeline.tsx`
- Test: `packages/claxedo-app/e2e/playwright/core-harness-rendering-matrix.spec.ts`

**Approach:**
- Derive task cards and chips only from `data.resolveSubagents(parentSessionId, toolCallId)`.
- Remove tool-status, tool-metadata, title, and placeholder-key paths that manufacture a subagent view when no host row exists.
- Scope interaction-card selection to the parent timeline’s `data-session-timeline-session-id` before matching `data-subagent-key` and spawn role.
- Use one shared helper to dispatch the cancelable `claxedo:open-subagent` event for pointer, Enter, and Space activation.
- Let the app timeline owner open the dedicated read-only child pane and remember the exact origin element for focus restoration.
- Preserve direct navigation only when no pane owner cancels the event and an authoritative child session is openable.

**Test scenarios:**
- **Happy path:** An authoritative ready association renders an openable card and chip with host status and identity.
- **Absence:** A task tool with no authoritative association renders no card or chip, including bare Pi.
- **Edge case:** An association with `not-yet-bound` or `unavailable` transcript state renders the host-owned non-openable state without invented child identity.
- **Parent scoping:** Two timelines reuse one `subagentKey`; interaction from parent B focuses parent B’s spawn card only.
- **Keyboard parity:** Enter on an openable spawn card dispatches the same event detail as a primary-button click and opens the dedicated child pane.
- **Keyboard parity:** Space follows the same event path and does not invoke ordinary navigation first.
- **Focus:** Closing/backing out of the narrow read-only child pane restores focus to the originating spawn card.
- **Modifier behavior:** Modified clicks preserve link semantics and do not dispatch the pane-open event.

**Verification:**
- Session UI tests contain negative assertions for all synthesized paths, and the browser scenario proves keyboard pane placement plus focus restoration.

- [x] **Unit 6: Close the review matrix with production-shaped evidence**

**Goal:** Prove all review findings are fixed through focused package tests and deterministic browser coverage.

**Requirements:** R9, R10

**Dependencies:** Units 1–5

**Files:**
- Test: `packages/agent-sdk-runtime/src/subagent-admission.test.ts`
- Test: `packages/agent-sdk-runtime/src/harnesses/claude/driver.test.ts`
- Test: `packages/claxedo-app/src/app/workbench/context/directory-scope.vitest.tsx`
- Test: `packages/claxedo-server/src/session/meta/index.test.ts`
- Test: `packages/claxedo-server/src/session/runtime.test.ts`
- Test: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.test.ts`
- Test: `packages/session-ui/src/components/message-part.test.ts`
- Test: `packages/claxedo-app/e2e/playwright/core-harness-rendering-matrix.spec.ts`

**Approach:**
- Run focused owning tests after each unit from the appropriate package directory.
- Run full tests and typechecks for Agent SDK Runtime, Workspace Runtime, Claxedo Server, Session UI, and the relevant Claxedo App gates.
- Run the complete 13-scenario Chromium subagent matrix, including the narrow keyboard/focus path, bare-Pi absence, valid/invalid Cursor transcript cases, and unauthorized parent rejection.
- Search production UI code for removed synthesized identifiers and metadata-derived child identity.
- Keep failures visible; do not filter, retry into green, or substitute hand-authored measurements.

**Test scenarios:**
- **Claude:** Real pending/provider-kind → late-agent-ID sequence retains one host key.
- **Hydration:** Partial live event precedes and survives complete durable hydration.
- **Deletion:** Parent deletion removes descendant runtime and projection state.
- **Cursor:** Production root accepts the canonical transcript and rejects workspace-local JSONL outside it.
- **Rendering:** Every supported rail renders from host associations; unsupported/absent rails render no synthetic surface.
- **Interaction:** Mouse, Enter, and Space open the same read-only child pane; focus returns to the correct parent card.
- **Authorization:** A transcript request with the wrong parent session remains rejected.

**Verification:**
- All focused and package-level owning tests pass, all relevant package typechecks pass, and all 13 Chromium matrix scenarios pass.

## System-Wide Impact

- **Interaction graph:** Harness observations enter admission, publish host events, persist associations, hydrate into the app registry, project through `resolveSubagents`, and dispatch app-owned pane events. Each unit repairs one authoritative seam in that chain.
- **Error propagation:** Ambiguous or conflicting identity observations fail at admission. Hydration failures remain retryable. Transcript confinement failures return unavailable/authorization errors. UI absence remains absence.
- **State lifecycle risks:** Late binding must preserve revisions; durable hydration must not regress live state; recursive deletion must be atomic; workspace reset must clear loaded registry state; pane focus must remain tied to the originating parent.
- **API surface parity:** OpenCode, Claude, Codex, Cursor, ACP, and Pi continue using one host-facing `subagent-updated` contract. Rail-specific differences appear only as authoritative resolution states and capabilities.
- **Integration coverage:** Unit tests prove local contracts; server/runtime tests prove persistence and security; the browser matrix proves the full producer-to-pane path.
- **Unchanged invariants:** Contract version 4, compat projection purity, transcript handle authorization, read-only child panes, and `(parentSessionId, subagentKey)` host identity remain unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Late-binding matching attaches to the wrong unbound association | Require a sole compatible correlation match; ambiguity never resolves arbitrarily. |
| Durable snapshot overwrites newer live state | Preserve registry revision ordering and add the live-newer-than-durable race case. |
| Recursive deletion follows a malformed cycle forever | Use a visited set and delete every reachable ID once inside one transaction. |
| Cursor’s path algorithm drifts | Pin representative workspace-to-slug cases and keep root computation in one exported production helper. |
| Removing synthesized UI state makes a producer bug less visually forgiving | This is intentional contract visibility; producer and hydration tests guarantee supported rails emit the association. |
| Keyboard and mouse paths drift again | Route both through one helper and assert identical event details. |
| Hand-authored performance fixtures give false confidence | Count only frames and bytes emitted by the real Claude ingestion boundary. |

## Documentation / Operational Notes

- Keep comments focused on immutable identity, hydration completion, transcript confinement, and input parity.
- No contract-version bump, database schema migration, feature flag, or compatibility event is required.
- Record package test counts and the 13 browser scenarios in the implementation handoff.

## Completion Evidence

- Agent Event Runtime: 135 tests passed; typecheck passed.
- Agent SDK Runtime: 384 tests passed, 4 skipped; typecheck passed.
- Workspace Runtime: 858 tests passed, 2 skipped; typecheck passed.
- Focused Claxedo Server metadata/runtime/embedded tests: 57 tests passed; typecheck passed.
- Focused Session UI contract tests: 13 tests passed; typecheck passed.
- Claxedo App durable-hydration tests: 16 tests passed.
- Claxedo App direct compile, E2E typecheck, and performance/reactivity gates passed; the performance/reactivity gates ran 43 tests.
- Chromium harness rendering matrix: 30 tests passed, including all 13 subagent scenarios and the keyboard/focus path.
- Fresh confidence-gated review found no remaining finding in F1-F7 or V1.

## Sources & References

- Parent implementation plan: `docs/plans/2026-08-07-002-feat-cross-harness-subagents-plan.md`
- Admission owner: `packages/agent-sdk-runtime/src/subagent-admission.ts`
- Hydration owner: `packages/claxedo-app/src/app/workbench/context/directory-scope.tsx`
- Central metadata owner: `packages/claxedo-server/src/session/meta/index.ts`
- Cursor production wiring: `packages/claxedo-server/src/deployments/local/embedded-workspace-runtime.ts`
- Authoritative UI consumers: `packages/session-ui/src/components/message-part.tsx`, `packages/session-ui/src/components/subagent-chip.tsx`
- Browser closure: `packages/claxedo-app/e2e/playwright/core-harness-rendering-matrix.spec.ts`
