# User Journeys

## Journey 1: Solo user starts a personal session

Actor: signed-in solo user

1. The user signs in and opens Claxedo.
2. The system resolves the user's implicit personal organization.
3. The user opens or creates a project and workspace without a personal-versus-team onboarding question.
4. The system assigns org and project identity at first write.
5. The user creates a session.
6. The system registers the user as creator before returning success.
7. The user submits a prompt and receives normal OpenCode-compatible streaming output.

Expected result: The experience remains as simple as the current single-user flow, but all stored resources carry explicit tenant and actor identity.

Failure states:

- Authority unavailable: show a retryable service failure, not a private-session denial.
- Session registration denied: return no session and allow retry with the same id.

## Journey 2: Org owner creates a collaborative workspace

Actor: organization administrator

1. The owner creates a collaborative **org** using the first-party org creation flow (nested default **team** is seeded).
2. The owner adds collaborators to the default team (and optionally creates more teams).
3. The owner creates a project for a repository under the org.
4. The system reuses the same project for the same canonical repository key inside the organization.
5. The owner creates a workspace under that project; `ensureDefaultTeam` mirrors team project grants.
6. Workspace access may also use direct workspace shares; session transcripts still require session share or participation.

Expected result: Org and Team are distinct. An existing personal workspace is never silently moved into the org.

Closure evidence: Convex and SQLite share the dependency-light canonical
repository-key implementation and parity corpus; finding #6 is closed.
Real-tier browser proof: `packages/claxedo-app/e2e/playwright/web-signed-org-team-multiplayer.spec.ts`.

## Journey 3: Creator shares one private session with a team

Actors: session creator, team member, and workspace-only peer

1. The creator creates a private session in a collaborative-org workspace.
2. A team member and a workspace editor (not on the team) cannot see the session.
3. The creator shares the session with the **team** (People UI / `session_share_grants`).
4. The team member's session list includes the session; they can open, read, and drive turns.
5. The workspace-only peer still cannot see the session.
6. Both authorized users see message authors; revoke of the team grant denies the member again.

Expected result: Workspace membership alone does not expose private transcripts. Explicit team (or user) session share enables HTTP, live, and replay access.

Closure evidence: signed global visibility, bounded live/replay authorization,
accurate authority status mapping, renewable grants, and producer-backed
attribution close findings #5, #8-#11, #15, and #28.
Real-tier video proof: `CLAXEDO_TIER_REAL_E2E=1` playwright `web-signed-org-team-multiplayer.spec.ts`
(artifacts under `test-results/evidence/web-signed-org-team-multiplayer/`).

## Journey 4: Two users submit at the same time

Actors: creator and collaborator

1. Both users view the same idle session.
2. Both submit prompts concurrently.
3. The durable admission owner atomically accepts one request.
4. The winner's turn starts and the session remains busy for both users.
5. The loser receives `409 session_turn_in_progress`.
6. The loser removes only its optimistic message and restores its input.
7. The system does not publish the rejection as a shared session error.

Expected result: Exactly one turn runs. Permission mode and optimistic UI state from the losing request do not affect the winner.

Closure evidence: the durable runtime store is the sole turn-admission owner
across runtime reconstruction; finding #23 is closed.

## Journey 5: Creator forks a shared session

Actor: authorized creator or participant with fork authority

1. The user opens an authorized source session.
2. The user requests a fork at an optional message boundary.
3. The runtime creates the child.
4. The authority registers the requester as child creator.
5. The runtime projects the new session and returns HTTP 201.
6. The creator can immediately read and prompt the child.
7. A nonparticipant cannot see the child.

Failure state: If child registration fails, the runtime deletes the child and returns the denial.

Closure evidence: ordinary and fork creation share the authority registration,
projection, compensation, and same-id retry protocol; finding #13 is closed.

## Journey 6: Administrator revokes a collaborator

Actors: organization administrator and collaborator

1. The collaborator has an open private transcript, SSE stream, and PTY.
2. The administrator removes the collaborator from the session or workspace.
3. The authority revokes current runtime authority as required.
4. New reads and writes fail immediately.
5. Stream lease renewal fails within the documented bound.
6. SSE and PTY connections close without sending further private bytes.
7. Process log aliases also deny the removed collaborator.

Expected result: Revocation is effective across primary and secondary routes, live delivery, replay, reconnect, and PTY output.

Closure evidence: participant administration requires current workspace
authority, process-log aliases resolve through session policy, and active
streams renew revocable grants; findings #3, #12, and #21 are closed.

## Journey 7: User reconnects after network loss

Actor: authorized participant

1. The participant loses the live event connection.
2. The client reconnects with its last event id and fresh establishment proof.
3. The runtime rebuilds only the participant's authorized replay.
4. Authorization is coalesced per session with bounded concurrency.
5. The stream becomes ready within a total deadline.
6. Live delivery continues in order after replay.

Expected result: Events for other sessions do not create visible gaps. Authority latency cannot hold the request for many minutes or grow an unbounded queue.

Closure evidence: one scoped decision, bounded queues/concurrency, ordered
replay, a fixed readiness deadline, renewable grants, and accurate 401/403/503
semantics close findings #8-#11 and #15.

## Journey 8: User keeps a terminal open

Actor: authorized session participant

1. The user opens a session PTY.
2. The short-lived relay proof authenticates connection establishment.
3. A revocable stream lease maintains authorization beyond proof expiry.
4. The user continues working beyond one minute.
5. Renewal checks current session/workspace authority.
6. Revocation closes the socket with no further output.

Expected result: Normal proof expiry does not terminate valid work. Revocation still propagates.

Closure evidence: the establishment proof is no longer reused as the long-lived
authority; renewable parent-linked session grants close finding #21.

## Journey 9: A legacy deployment upgrades

Actor: release operator

1. The operator deploys the expand schema.
2. The migration ledger runs user, project, membership, workspace, and session backfills in order.
3. Conflicting tenant/project provenance stops with a row-specific error.
4. Verification migrations prove required fields and cross-resource equality.
5. A legacy creator and participant open a migrated private session.
6. Only then are relay and runtime authorization changes promoted.
7. SQLite upgrades with services stopped and a pre-upgrade backup retained.

Expected result: Legacy sessions do not disappear when private-session enforcement turns on.

Closure evidence: session/workspace project equality is enforced in live writes
and migrations, and staging/production workflows run the ordered migration
ledger gate before runtime enforcement; findings #16 and #18 are closed in
code. The credentialed staging rehearsal remains a deployment action.

## Journey 10: Authority service is unavailable

Actor: any managed user

1. A session request or stream renewal reaches the runtime.
2. The runtime's authority request times out or returns 503.
3. The runtime fails closed but preserves the retryable unavailable status.
4. It does not mislabel the session as private or permanently forbidden.
5. Queues and reconnect work remain bounded.
6. The client retries with backoff and fresh authority.

Expected result: Security remains fail-closed without converting an outage into a false permission decision.

Closure evidence: bounded queue/deadline behavior and preserved 401/403/503
semantics close findings #9-#11.

## Journey 11: Existing central session restores and renders canonical state

Actor: authorized user reopening a central session

1. The direct route identifies a session from canonical inventory.
2. Explicit `central:<session-id>` identity prevents the route from being
   reclassified as a workspace-runtime session.
3. The pane hydrates session metadata, messages, capabilities, and saved model
   through the central resource authority.
4. The composer remains inert while the authoritative model restore is pending.
5. Canonical snapshots preserve intermediate assistant task parts and update
   them to their terminal lifecycle.
6. Authorized terminal subagent events remain available during replay, and the
   task card renders the child lifecycle rather than the parent tool error.

Expected result: authorization, transport placement, hydration, and rendering
agree on one session identity. A user does not see an empty model picker,
missing assistant reply, or permanently `Working` task after canonical state
has already completed.

## Cross-journey UX requirements

- Display user-facing `Team`, while code and API internals retain `org`.
- Never show internal database actor ids.
- Show a clear concurrent-turn error only to the losing sender.
- Distinguish retryable service unavailability from permission denial.
- Preserve the winner's busy state when the loser rolls back.
- Render unknown historical author honestly rather than assigning the current reader.
- Do not reveal the existence of an unauthorized private session through detailed errors.
