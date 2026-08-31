# Product Requirements: Tenant-Aware Multiplayer Sessions

## Product statement

Claxedo must allow multiple authorized people to collaborate in the same workspace and session without exposing private transcripts, misattributing actions, admitting overlapping turns, or breaking OpenCode-compatible clients.

This is a platform capability, not only a collaborative UI. Identity, authorization, persistence, runtime execution, event delivery, and revocation must agree on the same canonical tenant and actor model.

## Problem

The original system assumes one tenant and one effective user. That assumption appears in workspace creation, project identity, session ownership, prompt admission, message projection, PTY access, event replay, and deployment migrations.

Adding a second user without replacing those assumptions creates four failure classes:

1. Data can cross tenant or private-session boundaries.
2. Concurrent prompts can produce conflicting turns or permission state.
3. Messages and automated actions can be attributed to the wrong actor.
4. Revoked users can retain access through tokens, streams, or secondary routes.

## Personas

- Solo user: uses a personal organization without extra onboarding choices.
- Team owner or organization administrator: creates team resources and manages participants.
- Session creator: owns a private session and may manage its participants.
- Collaborator: participates in selected sessions inside an authorized workspace.
- Workspace viewer: can inspect permitted workspace surfaces but cannot execute or mutate.
- Runtime agent: performs work under an explicit, stable actor identity.
- Release operator: migrates legacy data and promotes the control plane and runtimes safely.

## Settled product principles

1. Session transcripts are private by default in the target model.
2. Personal organization creation remains implicit; onboarding does not ask users to choose personal versus team.
3. Existing personal workspaces are never silently moved into a team.
4. Session privacy protects transcript-bearing surfaces. Files and working trees remain governed by workspace access.
5. User-facing `Team` maps to code-level `org`; internal identifiers are not renamed for copy.
6. OpenCode is the external compatibility boundary. Claxedo internal shapes do not require compatibility aliases.
7. Team project/workspace creation requires write authority.
8. Session participant management is limited to the current creator or organization administrator, and both must retain current workspace authority.

## Goals

- Make org, project, workspace, actor, and session identity explicit at every creation boundary.
- Admit at most one active prompt turn per session across runtime reconstruction.
- Attribute user messages to the verified actor that produced them.
- Enforce private-session read/write authority across every transcript-bearing HTTP, SSE, replay, reconnect, PTY, and compatibility surface.
- Make participant and workspace revocation effective for new requests and active connections within a documented bound.
- Keep OpenCode request, response, status, and event compatibility.
- Migrate Convex and SQLite data without guessing ambiguous tenancy.
- Prove the model with two real signed users and production-like composition.

## Non-goals

- Per-session working-tree isolation.
- Automatic migration of personal workspaces into team organizations.
- A new onboarding branch for personal versus team selection.
- Renaming all internal `org` identifiers to `team`.
- Backward-compatible aliases for Claxedo-only internal data shapes.
- Public share links or anonymous session access.
- Redesigning OpenCode's external event vocabulary.

## Functional requirements

### FR1: Canonical resource identity

- Every project has an opaque `project_id`, `org_id`, and canonical `repo_key`.
- Every workspace has immutable `org_id` and `project_id` assigned at creation.
- A session's project must equal its workspace's project.
- Convex and SQLite must use the same repository canonicalization contract.

### FR2: Stable actor identity

- The users registry is the canonical actor registry.
- Runtime access and relay host tokens carry `actor_id` and immutable `actor_kind`.
- Human and agent activity cannot mutate one actor record between kinds.
- Unknown or historical identity remains unattributed rather than borrowing the current reader or synchronizer.

### FR3: Atomic prompt admission

- One durable per-session lease is the sole admission owner.
- Both `message` and `prompt_async` use the same admission path.
- A collision returns structured HTTP `409` with `session_turn_in_progress` only to the losing sender.
- Rejected permission state is discarded and no rejection is broadcast as a session error.
- Runtime restart or reconstruction does not lose an active lease.

### FR4: Private-session lifecycle

- Session creation registers the creator before returning success.
- Fork registers the child creator before returning success.
- Failed registration compensates by deleting the created runtime session.
- List and search filter unauthorized sessions rather than failing the entire collection.
- Creator, participant, or organization-admin session authority is conjunctive with current workspace authority.

### FR5: Complete transcript-surface coverage

- Session metadata, messages, commands, prompts, history, diffs, summaries, and shares use `SessionAccessPolicy`.
- PTY reads, snapshots, WebSockets, process-log aliases, and transcript-bearing compatibility routes use the same policy.
- Workspace viewers cannot reach execution or write primitives.

### FR6: Live, replay, and reconnect authorization

- Connections attach verified actor, org, workspace, and role identity.
- Live delivery, retained replay, reconnect drain, and proxied compatibility delivery use one decision contract.
- Sessionless global events use the canonical tenant/subject allowlist and default-deny unclassified signed frames.
- Authorization work has bounded concurrency, bounded queues, and a total reconnect readiness deadline.
- A decision is not repeated for the same connection and frame.

### FR7: Long-lived stream revocation

- The short-lived relay host token authenticates connection establishment only.
- A renewable stream lease supports long-lived PTY and SSE connections.
- The lease is linked to revocable parent authority.
- Renewal denial, participant removal, or token revocation closes the connection.
- Normal token expiry alone does not close an otherwise authorized connection after about 60 seconds.

### FR8: Attribution

- New user messages persist the verified producer actor id.
- Projections expose display-safe public actor identity and never internal authority identifiers.
- Existing canonical authors are preserved.
- Historical rows without producer-backed identity remain unknown.

### FR9: Migration and rollout

- Tenant migrations are ordered, resumable, idempotent, and ledger-backed.
- Verification migrations prove required identities and cross-resource equality.
- Staging and production deployment stop before runtime publication when migration verification fails.
- SQLite upgrade uses the documented stopped-service hard cut and backup.

### FR10: OpenCode compatibility

- Existing OpenCode success response shapes and event names remain unchanged.
- Structured Claxedo extensions remain ignorable by upstream-compatible clients.
- Authority outage remains a retryable 503, not a permanent private-session 403.

## Acceptance criteria

- Two signed users in one workspace can create and collaborate in an explicitly shared session.
- A nonparticipant cannot list, read, prompt, replay, reconnect, inspect PTY logs, or receive events for that session.
- Participant removal stops new access and active live delivery within the documented lease bound.
- Two simultaneous prompts admit exactly one turn; the loser receives `409 session_turn_in_progress`.
- The same test passes after runtime reconstruction against the same durable store.
- A forked child is immediately usable by its creator and invisible to a nonparticipant.
- Registration denial leaves no runtime session behind and retrying the same id succeeds when authority recovers.
- A private PTY stays connected beyond 60 seconds while authority remains valid.
- Sessionless global events never cross org or subject boundaries.
- Convex and SQLite return equivalent decisions for owner, admin, creator, participant, revoked member, and outsider.
- Legacy migration rejects or quarantines conflicting tenant/project provenance.
- The deployment workflow runs backfills, verification migrations, and a legacy-session smoke before promotion.

## Success measures

- Zero cross-tenant or nonparticipant transcript deliveries in policy tests and deployed smoke.
- Zero orphan sessions after registration failure.
- Exactly one admitted turn in all concurrent-prompt tests.
- No incorrect known-author substitutions during transcript sync.
- Bounded authority calls per active session grant rather than per event frame.
- Bounded replay readiness and authorization queue depth under authority latency.
- No valid PTY disconnect caused only by the one-minute relay host token expiry.

## Current readiness

The target requirements are implemented for the reviewed architecture. All 18
validated findings covering FR1 through FR9 are closed; FR10 retains OpenCode
compatibility, including distinct 401, 403, and retryable 503 behavior.

The post-review browser lane found two end-to-end projection defects after
authority had already admitted and delivered the canonical data:

- existing central Pi sessions restored the correct model in session/config
  data but exposed an actionable empty-model toolbar before restoration;
- Codex ACP child work reached canonical completion but terminal subagent
  lifecycle was not retained/projected consistently to the task card.

The follow-up implementation fixes the authoritative producer and projection
paths rather than weakening the E2E assertions. Current executed evidence,
remaining environment gates, and any still-running verification are recorded
in `verification-and-rollout.md`; a fresh agent should start with
`continuation.md`.
