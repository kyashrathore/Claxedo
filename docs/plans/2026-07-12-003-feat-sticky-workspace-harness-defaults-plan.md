---
title: "feat(session): Remember the workspace harness/model pair"
type: feat
status: completed
date: 2026-07-12
---

# feat(session): Remember the workspace harness/model pair

## Overview

New session drafts should remember the last selected harness and the concrete model selected with that harness for their workspace. The preference stores one atomic `{ harness, model? }` pair plus optional non-authoritative display labels. The model uses the existing complete `ModelKey` shape, so OpenCode, Pi, ACP, and native harnesses all restore through the same contract while validating against their own model source.

This is an app-side draft preference. It initializes future drafts and never replaces durable session config, harness-specific catalog/options authority, credential authority, or the first-prompt model lock.

## Problem Frame

The harness store currently has transient draft state and durable created-session state, but no durable authority for the next draft. `harness-preferences.ts` can read legacy pane maps, while its write and promotion paths are intentionally inert. As a result, a harness/model choice can survive the active draft but a later draft cannot restore that pair. Pi makes the gap especially visible because its empty fallback renders an unexplained model selector even when providers are configured.

Users experience this as two related failures: their chosen harness/model is not sticky for the workspace, and Pi can open with “Select model” even when a usable provider is already configured.

## Requirements Trace

### Persistence and identity

- **R1 — Sticky workspace default:** A new draft restores the last harness explicitly chosen for that workspace.
- **R2 — Complete model identity:** The model selected with the saved harness is stored and restored as a complete `ModelKey`; a model ID alone is never sufficient identity for any harness.
- **R3 — Stable scope:** Drafts and surfaces for the same canonical workspace share the default; different workspaces and server authorities do not.

### Resolution and recovery

- **R4 — Harness-specific eligibility:** A restored model becomes effective only when the saved harness’s current model source accepts the exact `ModelKey`: the connected OpenCode catalog for OpenCode, the connected Pi catalog for Pi, and live config options/default semantics for ACP/native harnesses.
- **R5 — Safe recovery:** A saved model that becomes disconnected or disappears does not silently change to another model. The saved harness remains selected, the friendly saved model label remains visible as unavailable, submission stays blocked, and the selector offers the recovery action appropriate to that harness.
- **R6 — Useful missing-model default:** A saved harness with no explicit model uses that harness’s existing declared default policy. Pi first tries the exact eligible current OpenCode pair, then selects a provider default only when exactly one connected Pi provider has a catalog-valid default; multiple or zero qualifying providers leave Pi awaiting a model choice.
- **R7 — Atomic user-action writes:** After an accepted harness choice, persist that harness with the concrete eligible model currently selected for it, including its declared default, or no model when none is eligible. A later explicit model selection replaces the entire pair only when it belongs to the currently selected harness and is accepted. Standalone credential connection, background hydration/fallback, reconnect, and existing-session restoration do not write the default.
- **R8 — Provider hierarchy:** The Pi picker mirrors the OpenCode hierarchy: connected providers and their models appear in a top “Configured” section, followed by disconnected “Available providers” connection actions.

### Authority and lifecycle safety

- **R9 — Session authority:** Existing sessions always hydrate from server session config. Draft preference restoration never changes an existing session or bypasses the first-prompt lock.
- **R10 — Async safety:** Late storage, catalog, config-options, provider, OAuth, workspace, or local harness-status responses cannot overwrite resolved default ownership, an explicit draft choice, a different workspace, or a promoted session.
- **R11 — Placement compatibility:** Drafts on placements that do not support the saved harness continue to use the placement’s supported default without erasing the saved local harness/model preference.

## Scope Boundaries

- The preference controls one last selected harness/model pair for future drafts. It is not a per-harness history map.
- Existing harness-specific model systems remain eligibility and interaction authorities. The workspace record is only the paired initial selection for a new draft.
- Provider credentials, catalog contents, server session metadata, runtime backend resolution, and OAuth token storage are unchanged.
- Existing legacy harness/model maps remain a compatibility-only read path for their current consumers. They never seed or mutate the new workspace default because their pane-scoped values cannot safely define workspace-wide intent.
- Cross-device synchronization is out of scope. Browser/desktop persistence is last-write-wins for future drafts; already-open drafts remain stable.
- Shared hosted Pi execution remains separately scoped until the hosted control plane has a tenant credential owner.

## Context & Research

### Relevant Code and Patterns

- `packages/claxedo-app/src/features/session/harness/harness-preferences.ts` reads legacy scoped maps but deliberately does not write them.
- `packages/claxedo-app/src/features/session/preferences/pane.ts` distinguishes pane/draft/session scopes and supplies malformed-value and promotion patterns.
- `packages/claxedo-app/src/platform/runtime/session-workspace.ts` provides the canonical workspace-key pattern used to collapse workspace IDs and directory aliases.
- `packages/claxedo-app/src/platform/persistence/persist.ts` supplies server/workspace-scoped persistence and migration conventions.
- `packages/claxedo-app/src/features/session/harness/harness-hydrator.ts` separates draft hydration from existing-session server config.
- `packages/claxedo-app/src/features/session/harness/harness-store.ts` and `packages/claxedo-app/src/features/session/composer/ui/submit.ts` own transient draft-to-session promotion.
- `packages/claxedo-app/src/features/session/ui/controls/agent-harness-selector.tsx` currently owns Pi catalog eligibility, connection completion, and the inline OpenCode-model fallback.
- `packages/claxedo-app/src/features/session/providers/models.tsx` demonstrates that OpenCode’s model authority is already workspace-persisted and filtered to connected providers.
- `packages/claxedo-app/src/features/session/store/local-selection-handoff.ts` carries complete model identity transiently but is intentionally not reload persistence.

### Institutional Learnings

- `docs/plans/2026-07-12-002-feat-pi-provider-model-selection-plan.md` establishes exact provider/model identity, no silent model substitution, harness-scoped provider catalogs, and server-owned created-session durability.
- `packages/claxedo-app/e2e/INVARIANTS.md` requires harness ownership to remain consistent through draft, first send, reload, and follow-up.
- No `docs/solutions/` directory exists, so there are no additional formal solution records for this area.

### External References

External research is unnecessary: the repository already contains direct patterns for workspace persistence, full model identity, catalog eligibility, draft promotion, and server session authority.

## Key Technical Decisions

- **Create a new versioned workspace-default record:** Keep it separate from the legacy pane maps so future-draft convenience cannot become a second durability authority for created sessions.
- **Key by server authority plus canonical workspace identity:** Prefer the resolved workspace ID and fall back to the canonical local directory. When identity transitions from directory to workspace ID, read both targets, prefer an existing workspace-ID record, otherwise atomically promote the directory record and remove it only after the canonical write succeeds. Do not include pane, surface, draft, or session IDs.
- **Store the selected pair atomically:** A single record contains `harness` plus the optional complete model selected with that harness. Changing harness replaces the previous pair rather than retaining a hidden model from another harness. Cancelling a picker or failed authentication does not mutate the record.
- **Persist display labels only as recovery hints:** Optional provider/model names are stored with the pair so a removed model remains recognizable. They never participate in identity, eligibility, submission, or server requests; live catalog/options labels replace them whenever available.
- **Reuse the shared `ModelKey`:** OpenCode and Pi retain real provider IDs; config-option harnesses use the harness ID as provider ID, matching `harnessModelKeyForSubmit()`. The record does not invent a Pi-only or harness-specific model shape.
- **Keep model-source ownership unchanged:** OpenCode provider state, Pi provider state, and ACP/native config options determine whether a saved pair is valid and what recovery is possible. The preference is never treated as catalog truth.
- **Use a pure default resolver:** Feed it the saved pair, current-draft authority, placement capability, selected harness’s eligibility snapshot, and that harness’s declared fallback inputs. This makes precedence and exact eligibility independently testable.
- **Track draft authority and revision:** Distinguish unresolved/defaulted/explicit/server-owned state so asynchronous default resolution cannot overwrite user intent or an existing session.
- **Do not rewrite stale saved pairs automatically:** A disconnected or removed saved model enters recovery for its harness. Automatic fallback is reserved for records with no model.
- **Keep Pi’s automatic selection unambiguous:** After the exact OpenCode-pair candidate, Pi selects a provider default only when exactly one connected provider has a valid declared default. Provider order is presentation-only and never decides model authority.

## Open Questions

### Resolved During Planning

- **Is the preference pane-specific or workspace-wide?** Workspace-wide. It initializes future drafts across surfaces while leaving already-open drafts independent.
- **Should an invalid saved model fall through to another model?** No. Preserve the exact harness/model intent and require recovery; refreshed options or credentials can make it valid again.
- **Should the record retain one model per harness?** No. It stores the model paired with the last selected harness, matching what the next draft should restore.
- **Should OpenCode be included?** Yes. Its selected `ModelKey` is stored in the same atomic pair, while the existing OpenCode subsystem remains the live eligibility and picker authority.
- **Should background default resolution update the saved preference?** No. An accepted harness action snapshots its currently selected concrete model, but later hydration/fallback changes do not rewrite the pair without another user action.

### Deferred to Implementation

- **Exact storage adapter shape:** Select the smallest adapter that supports the app’s web and desktop persistence platforms while retaining server/workspace scoping. The preference contract and migration behavior are fixed; helper names are not.
- **Final recovery copy:** Reuse the existing picker’s disconnected/unavailable language where possible and finalize wording during browser verification.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

| Draft condition | Effective result | Preference write |
|---|---|---|
| Placement cannot run the saved harness | Placement-supported default harness/model | None |
| Existing session | Server-configured harness/model | None |
| Current draft has an explicit choice | Current explicit harness/model | Explicit action already wrote it |
| Saved harness/model pair is exact and eligible | Saved harness/model pair | None |
| Saved model is removed/disconnected/unsupported | Saved harness with blocked recovery state | None |
| Saved non-Pi harness has no model | Harness-specific existing declared default, or blocked choice if none | None |
| Saved Pi has no model; current OpenCode pair is Pi-eligible | Pi with exact OpenCode pair | None |
| Saved Pi has no model; exactly one connected Pi provider has a valid default | Pi with that provider default | None |
| Saved Pi has no model; multiple or zero qualifying providers | Pi with “Choose a model” | None |
| No saved harness | Existing OpenCode draft behavior | None |

The resolver applies once to a new draft after its required preference and eligibility inputs settle. Every asynchronous application captures workspace, draft scope, and revision. It is discarded if any identity changed, the user made an explicit selection, or the draft was promoted. While unresolved, the selector keeps its layout stable, shows a neutral loading label, and keeps submission disabled; “Choose a model” appears only after resolution proves there is no effective model.

### Selector State Contract

| State | Selector presentation | Submit | Primary action |
|---|---|---|---|
| Preference/catalog/credential inputs unresolved | Stable-width neutral loading label | Disabled | None until resolution settles |
| Exact eligible model resolved | Friendly provider and model label | Enabled when other composer gates pass | Open picker |
| No saved model and no unambiguous eligible default | “Choose a model” | Disabled | Open picker at Configured section |
| Saved provider disconnected | Saved friendly provider/model label marked “Disconnected” | Disabled with accessible reason | Reconnect; secondary Change model |
| Saved model removed from catalog | Saved friendly provider/model label marked “Unavailable” | Disabled with accessible reason | Change model |
| Catalog/credential query failed | Non-destructive “Models unavailable” status | Disabled | Retry; retain saved intent |
| Preference storage failed | Continue with unsaved current-draft behavior after eligibility resolves | Based on effective draft selection | Normal picker actions |

Loading, recovery, and restored-selection changes use polite status announcements. Connection-dialog close returns focus to the initiating provider/model row.

## Implementation Units

- [x] **Unit 1: Add the workspace draft-default preference contract**

**Goal:** Persist and decode one atomic, versioned `{ harness, model? }` default per server-scoped workspace without reactivating legacy pane maps.

**Requirements:** R1, R2, R3, R7

**Dependencies:** None

**Files:**
- Create: `packages/claxedo-app/src/features/session/harness/draft-defaults.ts`
- Create: `packages/claxedo-app/src/features/session/harness/draft-defaults.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/harness-preferences.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-preferences.test.ts`
- Reference: `packages/claxedo-app/src/platform/persistence/persist.ts`
- Reference: `packages/claxedo-app/src/platform/runtime/session-workspace.ts`

**Approach:**
- Define a versioned record containing a validated harness, an optional complete `ModelKey` belonging to that same harness, and bounded optional provider/model display labels used only for unavailable-state copy.
- Validate model ownership structurally: OpenCode accepts its provider/model key, Pi accepts its provider/model key, and config-option harnesses require `providerID === harness`. Live eligibility remains a resolver concern.
- Use a server/workspace identity rather than the current pane preference scope.
- Keep legacy map reads intact for existing consumers, keep their write/promotion behavior inert, and exclude them from new-default resolution.
- Reconcile the directory fallback and resolved workspace-ID targets by preferring an existing ID-keyed record; when only the directory record exists, write it to the ID target before deleting the fallback. If canonical promotion fails, keep the fallback readable.
- Treat malformed JSON, unknown versions/harnesses, partial model keys, blank IDs, and storage failures as no usable preference.
- Make preference replacement atomic.

**Patterns to follow:**
- `createPanePreferences()` for strict parse/fallback behavior.
- `Persist.serverWorkspace()` and `sessionPaneWorkspaceKey()` for stable scoping.
- `cloneLocalSelectionState()` for copying complete model identity without sharing mutable objects.

**Test scenarios:**
- Happy path: save Pi plus an OpenAI Codex model in workspace A, reconstruct the preference owner, and read the identical complete pair.
- Happy path: save `codex-acp` plus `{ providerID: "codex-acp", modelID: "gpt-5.5" }` and restore the exact pair.
- Happy path: save OpenCode plus its selected provider/model pair and restore the exact pair.
- Happy path: save a harness with no explicit model and read the same harness with no model.
- Edge case: workspace A and workspace B retain independent records, while two surfaces in A read the same record.
- Edge case: equivalent workspace ID and directory aliases resolve to one canonical preference key when inventory data is available.
- Race: write through the directory fallback before inventory resolves, then resolve the workspace ID and recover/promote the same record without loss.
- Conflict: if both directory and workspace-ID records exist, the workspace-ID record wins and the stale fallback never overwrites it.
- Error path: malformed JSON, unknown version, unknown harness, array payload, partial key, or blank ID is ignored without throwing.
- Error path: a storage read/write failure leaves current in-memory draft behavior usable.
- Regression: legacy harness/model maps remain read-only and cannot produce a newly mismatched atomic record.
- Error path: reject a model key whose provider identity cannot belong to the saved config-option harness.
- Recovery: a removed model uses its stored display hint while the exact `ModelKey` remains the only identity checked.
- Regression: changing harness replaces the old atomic pair and cannot attach the previous harness’s model to the new harness.

**Verification:**
- A reload can recover one exact workspace default, with no persistence writes under session or pane keys.

- [x] **Unit 2: Centralize default resolution and draft authority**

**Goal:** Resolve a safe effective default and prevent late asynchronous work from replacing user or server authority.

**Requirements:** R4, R5, R6, R7, R9, R10, R11

**Dependencies:** Unit 1

**Files:**
- Create: `packages/claxedo-app/src/features/session/harness/draft-default-policy.ts`
- Create: `packages/claxedo-app/src/features/session/harness/draft-default-policy.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/store-state.ts`
- Test: `packages/claxedo-app/src/features/session/harness/store-state.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/harness-store.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-store.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/controller.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/store-policy.ts`
- Test: `packages/claxedo-app/src/features/session/harness/store-policy.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/options-state.ts`
- Test: `packages/claxedo-app/src/features/session/harness/options-state.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/harness-options-loader.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-options-loader.test.ts`

**Approach:**
- Express resolution as a pure policy over plain values, including placement capability, the saved pair, harness kind, exact eligibility from the harness’s current model source, and the harness’s declared fallback inputs.
- Represent draft authority as unresolved, defaulted, or explicit; existing-session hydration becomes server-owned authority.
- Increment or replace a draft revision on explicit selection, workspace change, and promotion. An automatic result applies only to its captured unresolved revision.
- Keep a stale saved model preference dormant when unavailable: the saved harness has no submit-ready effective model, and the stored record is not deleted or rewritten.
- Treat local draft harness-status hydration as readiness/options input only once workspace-default ownership is resolved; it cannot replace the selected harness/model. Existing sessions remain server-status owned.
- Change config-option loading to publish live eligibility/current-default input to the resolver instead of independently replacing a restored or explicit model. A saved missing model remains blocked; fallback to the live current/first option is allowed only when the pair contains no model.
- Carry an accepted harness action under the same draft revision while its config options settle. Persist the eligible resolved pair when available; if loading reaches a terminal failure with no concrete model, persist the accepted harness with no model rather than retaining a pair from the previous harness.
- Replace the broad workspace-runtime reset with capability-based behavior that forces OpenCode only where alternate harnesses truly cannot run.

**Execution note:** Implement the pure precedence and revision policy test-first because later UI integration depends on its exact ordering.

**Patterns to follow:**
- Pure decision helpers in `store-policy.ts`.
- Current harness hydration stamp/pending guards in `harness-hydrator.ts`.
- Existing full-model submit readiness in `selection.ts`.

**Test scenarios:**
- Happy path: an eligible saved exact pair restores for OpenCode, Pi, an ACP harness, and a native harness.
- Happy path: Pi with no saved model reuses an exact connected OpenCode pair.
- Happy path: a config-option harness with no saved model uses its live current/default option and emits the canonical harness-owned `ModelKey`.
- Happy path: when that pair is unavailable and exactly one connected provider has a catalog-valid declared default, select it.
- Edge case: when multiple connected providers have catalog-valid defaults, retain Pi with no model and require an explicit choice.
- Edge case: the same model ID under another provider is not an exact match.
- Edge case: a provider default absent from that provider’s model catalog is skipped.
- Recovery: a disconnected, removed, or no-longer-supported explicit pair leaves its saved harness selected with no effective model and leaves persistence untouched.
- Recovery: a saved ACP/native model missing from refreshed config options remains visible as unavailable and does not fall through to `default`.
- Race: a late config-options loader cannot substitute its live current/first option over a restored stale pair or a newer explicit model selection.
- Write timing: an accepted config-option harness switch persists its resolved pair after options settle, while a terminal options failure persists harness-only intent.
- Placement: unsupported workspace placement resolves the supported default regardless of the saved harness/model pair and does not erase it.
- Authority: existing session config bypasses the draft resolver.
- Race: late preference/catalog resolution cannot overwrite an explicit click, a changed workspace, or a promoted session.
- Race: local harness status arriving before or after default resolution can update readiness/options but cannot take model ownership or overwrite a click.
- Race: the last of two rapid explicit selections owns the revision.

**Verification:**
- Every precedence and race outcome is determined by pure policy tests before UI orchestration uses it.

- [x] **Unit 3: Integrate sticky defaults with the shared selector and provider eligibility**

**Goal:** Restore defaults for new drafts, persist explicit choices, and expose clear connected/recovery states through the existing selector.

**Requirements:** R1, R4, R5, R6, R7, R8, R10

**Dependencies:** Units 1–2

**Files:**
- Modify: `packages/claxedo-app/src/features/session/ui/controls/agent-harness-selector.tsx`
- Test: `packages/claxedo-app/src/features/session/ui/controls/agent-harness-selector.vitest.tsx`
- Modify: `packages/claxedo-app/src/features/session/harness/harness-switcher.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-switcher.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/harness-model-writer.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-model-writer.test.ts`
- Modify: `packages/claxedo-app/src/features/session/harness/harness-config-store.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-config-store.test.ts`
- Modify: `packages/claxedo-app/src/features/session/providers/session-selection.tsx`
- Create: `packages/claxedo-app/src/features/session/providers/session-selection.test.tsx`
- Modify: `packages/claxedo-app/src/app/providers/use-providers.ts`
- Modify: `packages/claxedo-app/src/features/session/composer/composer.tsx`
- Modify: `packages/claxedo-app/src/features/session/composer/ui/frame.tsx`
- Modify: `packages/claxedo-app/src/features/session/composer/ui/toolbar-controls.tsx`

**Approach:**
- Thread the stable workspace identity and placement capability to the harness selection boundary.
- Replace harness-specific inline restoration/fallback decisions with the centralized resolver once the saved harness’s eligibility inputs are ready.
- Persist an accepted harness change as one atomic pair using the concrete eligible model selected for that harness, including its resolved declared default, or no model when none is eligible. Never carry the old harness’s model into the new harness record.
- Route explicit model changes from both the OpenCode model controller and the shared harness selector through one preference writer that replaces the pair only when the model belongs to the currently selected draft harness.
- Preserve the intended exact model across connection UI and persist it only when that dialog continues an explicit selection and refreshed eligibility confirms success. Standalone connection never changes the preference.
- Mirror the OpenCode picker hierarchy with a top “Configured” section for connected providers/models and an “Available providers” section for connection actions; use friendly names rather than raw IDs.
- Keep both restored and already-open saved selections visible when their provider disconnects or model disappears, mark the friendly label unavailable, block submit, and expose primary “Reconnect” plus secondary “Change model” recovery.
- Preserve current keyboard navigation, restore focus after connection dialogs, expose friendly accessible names and the disabled-submit reason, and politely announce loading, connection failure, and restored-selection changes.
- Do not re-resolve already-open drafts on background catalog changes or cross-tab storage events.

**Patterns to follow:**
- Current captured scope/directory/session guards around harness switching and connection completion.
- Harness-scoped provider queries and invalidation in `useProviders("pi")`.
- Existing OpenCode `ModelKey` writes in `session-selection.tsx` and the shared model-selection command boundary.

**Test scenarios:**
- Integration: fresh drafts restore valid saved pairs for OpenCode, Pi, one ACP harness, and one native harness after their respective eligibility inputs are ready.
- Integration: a second new surface in the same workspace inherits the latest default; a surface already open before the change remains unchanged.
- Integration: changing workspaces restores independent defaults and discards a late response from the prior workspace.
- Happy path: switching to Pi without a saved model selects the exact eligible OpenCode pair, or the sole connected provider’s valid default; multiple qualifying providers require a choice.
- Happy path: selecting a model under any supported harness replaces the atomic workspace pair with that harness and exact `ModelKey`.
- Recovery: a disconnected provider or removed config-option model leaves its saved harness selected, keeps the friendly saved pair visible as unavailable, offers the applicable reconnect/change action, and keeps send disabled.
- Recovery: cancelling provider auth changes neither current selection nor preference.
- Error: a rejected harness switch does not update the workspace default.
- Integration: auth launched by an explicit model choice refreshes eligibility, selects the intended exact model, and persists it; standalone auth only refreshes eligibility.
- Race: user selection during catalog loading wins over late default application.
- Race: OAuth completion after navigation or draft disposal cannot mutate the destination draft.
- Regression: switching from Pi to `codex-acp` cannot persist the former Pi provider/model under `codex-acp`, and switching to OpenCode records its current OpenCode pair.
- Accessibility: keyboard selection, dialog focus restoration, accessible status/labels, and disabled-submit explanation remain correct through loading and recovery.

**Verification:**
- New drafts visibly restore or safely recover from the workspace default without transiently enabling an unverified model from any harness.

- [x] **Unit 4: Preserve draft promotion and prove the complete lifecycle**

**Goal:** Carry the resolved pair into session creation, transition authority to server config, and verify reload/locking behavior.

**Requirements:** R2, R9, R10, R11

**Dependencies:** Units 1–3

**Files:**
- Modify: `packages/claxedo-app/src/features/session/harness/harness-hydrator.ts`
- Test: `packages/claxedo-app/src/features/session/harness/harness-hydrator.test.ts`
- Test: `packages/claxedo-app/src/features/session/submit/handoff.test.ts`
- Test: `packages/claxedo-app/src/features/session/composer/ui/submit.new-session.test.ts`
- Test: `packages/claxedo-app/src/features/session/composer/ui/submit.harness.test.ts`
- Test: `packages/claxedo-app/e2e/playwright/harness-selection.spec.ts`

**Approach:**
- Keep transient draft-to-session promotion as an immediate UI handoff.
- Once created-session config is available, mark the scope server-owned and ignore late draft resolver results.
- Preserve the exact provider/model pair through session creation and subsequent hydration.
- Keep the existing first-user-prompt UI lock and server-side model lock unchanged.
- Add browser coverage for the user-visible reload/new-draft/recovery lifecycle.

**Patterns to follow:**
- Existing `harnessStore.promote()` state copy.
- Existing submit target handoff and server session-config hydration.
- Existing E2E invariants for harness ownership through first send and reload.

**Test scenarios:**
- Integration: restored OpenCode, Pi, ACP, and native harness/model pairs reach new-session creation unchanged and become durable server config.
- Integration: after promotion, a late catalog or config-options response cannot patch the session scope.
- Integration: reloading an existing session uses server config even when the workspace default has since changed.
- Locking: the selected harness model remains editable before the first admitted prompt and becomes read-only afterward.
- Isolation: changing the workspace default affects the next draft, not an existing session or another already-open draft.
- E2E: select a harness and model, open a second draft, observe restoration, send, reload, and observe the same locked pair; cover Pi plus one config-option harness.
- E2E recovery: disconnect a provider or remove a config-option model, open a new draft, observe the saved harness with blocked recovery, then reconnect/select and confirm future drafts restore the recovered pair.

**Verification:**
- The complete selected pair has one continuous ownership chain: workspace default for future drafts, transient draft state for the active draft, and server config after session creation.

## System-Wide Impact

- **Interaction graph:** Explicit harness/model actions replace the workspace pair; new-draft orchestration reads it; the selected harness’s provider catalog or config options validate it; submit promotion carries the effective pair; server config becomes authoritative after creation.
- **Error propagation:** Storage failures degrade to current transient behavior. Catalog/credential failures yield blocked recovery states. Server validation remains the final guard against a provider disconnect between resolution and submit.
- **State lifecycle risks:** The main risks are split harness/model writes, workspace alias duplication, late async overwrite, promotion races, and accidentally persisting automatic fallbacks. Atomic records, canonical identity, draft revisions, and explicit-write-only rules address them.
- **API surface parity:** No server API changes are required. The controller gains draft-default authority metadata, while existing session config and provider response contracts remain unchanged.
- **Integration coverage:** Unit tests prove persistence and precedence; component tests prove provider/selector orchestration; submit tests prove handoff; browser tests prove reload and user-visible recovery.
- **Unchanged invariants:** Existing sessions remain server-owned, each harness’s existing model source remains live eligibility authority, credentials never enter preference storage, and unsupported workspace-runtime drafts use their supported default.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| A restored pair appears submit-ready before provider/catalog/config-option validation | Keep the draft default unresolved until the saved harness’s eligibility inputs settle; never derive readiness from stored IDs alone. |
| A late resolver overwrites a user click or promoted session | Capture workspace/scope/revision and apply only to the matching unresolved draft. |
| Directory and workspace-ID aliases split preferences | Dual-read the fallback and canonical identities, prefer the ID record, and promote the fallback only after a successful canonical write. |
| Reusing legacy maps recreates session-local persistence debt | Add a new versioned workspace record and keep legacy maps outside its resolver and write path. |
| Automatic fallback silently changes saved intent | Do not fall through when a saved model is stale; require recovery and retain the preference unchanged. |
| Provider disconnects after resolution | Re-check client eligibility for UI readiness and rely on server validation at submit/execution. |
| Multiple surfaces unexpectedly live-update | Defaults initialize future drafts only; an explicit/current draft is never subscribed to live preference replacement. |
| Workspace capability is inferred from kind rather than actual placement | Centralize a capability decision and retain regression coverage for local, cloud, and user-hosted paths. |

## Documentation / Operational Notes

- Update `packages/claxedo-app/e2e/INVARIANTS.md` with the new workspace-default lifecycle and its separation from session durability.
- No database migration, credential migration, server rollout, or feature flag is required.
- Preference schema versioning permits future evolution; malformed or unsupported versions safely revert to current draft behavior.

## Sources & References

- Related plan: `docs/plans/2026-07-12-002-feat-pi-provider-model-selection-plan.md`
- Persistence: `packages/claxedo-app/src/platform/persistence/persist.ts`
- Workspace identity: `packages/claxedo-app/src/platform/runtime/session-workspace.ts`
- Legacy preference seam: `packages/claxedo-app/src/features/session/harness/harness-preferences.ts`
- Draft/session hydration: `packages/claxedo-app/src/features/session/harness/harness-hydrator.ts`
- Selector integration: `packages/claxedo-app/src/features/session/ui/controls/agent-harness-selector.tsx`
- Promotion: `packages/claxedo-app/src/features/session/composer/ui/submit.ts`
- Lifecycle invariants: `packages/claxedo-app/e2e/INVARIANTS.md`
