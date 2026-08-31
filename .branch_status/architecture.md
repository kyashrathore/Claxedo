# Architecture: Tenant-Aware Multiplayer Sessions

## System event that starts the flow

A human or agent opens a workspace through a Claxedo client. The control plane resolves the authenticated subject, organization, project, workspace, role, and actor. It mints runtime authority for the selected host. Every later session operation must derive authority from that canonical context.

## Authoritative owners

| Concept | Canonical owner | Responsibility |
|---------|-----------------|----------------|
| Human and agent actor | `users` registry in Convex/SQLite authority | Stable public actor identity and actor kind |
| Organization authority | organization and membership records | Owner/admin/member role and deletion state |
| Project identity | authority project store | Opaque project id and canonical repo key |
| Workspace identity | authority workspace store | Immutable org/project assignment and workspace role |
| Session authority | session history and participant records | Creator, participant, admin, read/write decisions |
| Prompt admission | `AgentRuntime` backed by durable `RuntimeStore` | Atomic acquire, run, and release per session |
| Runtime session state | workspace runtime adapter/store | Session, messages, PTY, process, and harness state |
| Live/replay policy | identity-aware event delivery | Per-principal authorization, bounded replay, reconnect |
| External compatibility | OpenCode-shaped routes and events | Stable request/response/event boundary |
| Schema rollout | Convex migration ledger and SQLite upgrade | Expand, migrate, verify, contract, rollback evidence |

## Component map

| Layer | Main packages | Change in this branch |
|-------|---------------|-----------------------|
| Client | `packages/claxedo-app` | Collision rollback, author rendering, runtime identity, event preparation |
| Control plane | `packages/claxedo-server`, `convex` | Actor/tenant identity, session authority, participant APIs, token revocation, migrations |
| Shared authority | `packages/claxedo-server-core` | Convex/SQLite adapters, auth claims, event visibility, repository keys |
| Relay | `packages/workspace-relay`, `packages/workspace-relay-protocol` | Required actor claims and relay proof verification |
| Workspace runtime | `packages/workspace-runtime` | Session policy, create/fork registration, PTY/process policy, live/replay filtering |
| Agent runtime | `packages/agent-sdk-runtime`, `packages/agent-event-runtime` | Turn lease, author-aware projection, OpenCode-compatible event projection |
| Local compatibility | `packages/claxedo-local-server` | Signed global-event and OpenCode route enforcement |
| Schemas | `packages/schema`, Convex schema, SQLite DDL | Required tenant, actor, participant, token, and attribution fields |

## Flow A: Open a managed workspace

1. The client authenticates with the control plane.
2. The authority resolves the canonical user row and stable actor identity.
3. `openWorkspace` resolves workspace role and immutable org/project identity.
4. The control plane mints a runtime access token with workspace, org, role, actor id, and actor kind.
5. The relay validates the token and mints the short-lived relay host proof used to establish the runtime request.
6. The workspace runtime constructs an `EventDeliveryPrincipal` and `SessionAccessPolicy` context from verified claims.
7. The result returns through OpenCode-compatible routes; internal tenant fields remain an implementation detail.

Failure behavior:

- Invalid or revoked runtime authority is 401/403 as appropriate.
- Authority unavailability remains 503 and is retryable.
- Missing actor attribution fails closed on managed private surfaces.

## Flow B: Create or fork a session

Implemented transaction:

1. The requester passes workspace and actor authorization.
2. The runtime creates or forks the adapter session with a known id.
3. The authority registers the creator and session tenant identity.
4. The runtime publishes the post-create projection/lifecycle event.
5. The route returns HTTP 201.

Compensation:

- If registration definitively fails, delete the adapter session before returning the denial.
- If both registration and cleanup fail, preserve both causes and emit reconciliation evidence.
- A fork follows the same registration and projection protocol as ordinary creation.

Closure evidence: findings #13 and #14 are closed by the create/fork
registration, compensation, cleanup-cause, and same-id retry tests named in
`review-findings.md`.

## Flow C: Submit a prompt

1. The app writes optimistic busy state for the sending client.
2. The runtime verifies session write authority.
3. `AgentRuntime` atomically acquires the durable session turn lease.
4. The verified actor and permission mode enter the adapter turn.
5. One winner runs. Any loser receives HTTP 409 with `session_turn_in_progress`.
6. The loser rolls back only its optimistic prompt and preserves the winner's busy state.
7. Completion or failure releases the lease in the authoritative store.

The lease survives runtime reconstruction because `AgentRuntime` requires
`AgentRuntimeStore.acquireTurnLease()` and `releaseTurnLease()`, and the
workspace runtime store persists the active lease. Finding #23 is closed.

## Flow D: Author and project messages

1. The live prompt producer attaches the verified actor id to the user message.
2. Runtime projection stores message id, session id, role, and canonical author id.
3. Authority synchronization preserves existing canonical authors.
4. The API projects only display-safe public id, name, and image.
5. The app renders the correct avatar and identity.

Historical messages without producer identity remain unattributed. The
synchronizing reader is never used as a substitute. Finding #28 is closed by
producer-backed author persistence and projection tests in both authorities.

## Flow E: Authorize private-session operations

The decision is conjunctive:

1. The actor has current workspace authority for the requested read or write.
2. The actor is the session creator, an active participant, or an organization administrator.
3. The session belongs to the requested workspace and tenant.
4. The resource is not deleted or revoked.

The same decision applies to:

- Session create/list/get/update/delete/fork.
- Messages, prompts, commands, history, diff, summary, share, and revert.
- PTY snapshots and sockets.
- Process log aliases that resolve to a PTY.
- Live events, retained replay, reconnect drain, and proxy streams.

Files and working trees remain workspace-authorized rather than session-private.

Closure evidence: findings #3, #12, #13, #14, and #24 are closed by current
workspace-authority checks, route/policy inventory tests, create/fork
compensation tests, and Convex/SQLite parity tests.

## Flow F: Deliver live and replayed events

Implemented design:

1. Connection establishment validates the short-lived relay host proof.
2. The runtime creates a connection principal with stable actor and tenant identity.
3. A renewable session read grant is acquired or checked for each relevant session.
4. The identity-aware source makes one decision per connection/frame and carries it to the writer.
5. Bounded queues and bounded authorization concurrency prevent authority latency from consuming memory.
6. Reconnect reconstructs authorized replay with per-session decision coalescing and a total deadline.
7. Renewal denial terminates the stream; ordinary proof expiry does not.
8. Sessionless global events use canonical org/subject visibility and deny unknown signed event types.

Closure evidence: findings #5, #8, #9, #10, #11, #15, and #21 are closed by
the signed two-user, bounded-queue, replay-deadline, status-preservation,
renewable-grant, and long-lived PTY/SSE tests.

## Flow G: Route and render an authorized central session

This flow is not a second authority model. It is the client projection that
preserves the identity already decided by the control plane and runtime.

1. The control-plane runtime stamps `session.updated` with canonical
   `workspaceID`, central host metadata, and `central:<session-id>` identity.
2. Inventory normalization preserves that placement instead of replacing it
   with the tool-sandbox directory.
3. Direct-route resolution recognizes the explicit central session and opens
   it through `openCentralSession`.
4. Session hydration keys include the resolved transport authority, so a warm
   local cache cannot satisfy a later central/signed read.
5. Canonical message snapshots and live events merge without dropping
   intermediate task parts or inventing assistant messages.
6. Terminal subagent lifecycle frames are retained for authorized replay and
   task cards render canonical child lifecycle even if the parent tool call
   reports an error.
7. Existing-session composer readiness waits for the authoritative saved model
   to restore before allowing submit.

This flow explains the post-review browser work. Authorization can correctly
admit and deliver an event while the app still misroutes, drops, or renders it
incorrectly; the client must preserve canonical identity all the way to the
visible session.

## Data model

### User

- Internal database id.
- Stable public id.
- Token identifier and identity-provider subject.
- Immutable actor kind: human or agent.
- Display-safe name and image.

### Project

- Opaque public `project_id`.
- `org_id`.
- Canonical `repo_key` shared by all backends.
- Owner and timestamps.

### Workspace

- Opaque workspace id.
- Immutable `org_id` and `project_id`.
- Owner, access mode, backing, host placement, and deletion state.

### Session

- Public session id.
- Workspace, org, and project identity.
- Creator actor/user id.
- Deletion and visibility state.

### Session participant

- Session id and user id.
- Role/grant metadata.
- Granted and revoked timestamps.

### Runtime authority

- Token id, workspace, host, user/actor, org, role, expiry, and revocation.
- Stream leases must reference revocable parent authority rather than reuse an expired connection proof.

### Message attribution

- Session id and message id.
- Role.
- Canonical author actor id for user messages when known.
- Projection timestamps/ordinal as required by the existing canonical message path.

## Required invariants

- No tenant identity is inferred from the current reader when an authoritative producer exists.
- Workspace org assignment never changes implicitly.
- Session project equals workspace project.
- Actor kind does not change because a different client type signs in.
- One session has at most one active admitted turn.
- A denied create or fork leaves no new runtime session.
- Revoked workspace authority overrides stale creator status.
- Every transcript-bearing route and event path invokes session policy.
- Live and replay paths use the same visibility decision.
- Authorization queues and reconnect readiness are bounded.
- OpenCode compatibility remains the external contract.

## Failure and recovery model

| Failure | Required response | Recovery |
|---------|-------------------|----------|
| Authority 401 | Invalid/expired proof | Re-authenticate and reconnect |
| Authority 403 | Current actor lacks permission | Do not retry without authority change |
| Authority 503 | Authority unavailable | Fail closed and retry with backoff |
| Prompt collision | 409 `session_turn_in_progress` | Roll back losing optimistic prompt only |
| Registration denial | No session side effect | Retry same id after authority recovery |
| Stream renewal denied | Close affected stream | Reconnect only after new authority |
| Stream authority slow | Bound queue/deadline | Terminate and replay after recovery |
| Migration conflict | Stop row/deployment | Operator resolves authoritative provenance |

## Target dependency direction

The control-plane authority owns identity and policy data. The runtime consumes signed authority and asks the session authority for current decisions. The app and compatibility layers consume runtime results. Neither the app nor a compatibility adapter may synthesize tenant or actor identity to repair a missing producer contract.

## Implementation source map

| Boundary | Canonical implementation |
|----------|--------------------------|
| Authority capability | `packages/claxedo-server-core/src/platform/auth/authority.ts` |
| Request principal binding | `packages/claxedo-local-server/src/workspace/sandbox-fetch-options.ts` |
| Workspace role precedence | `convex/model.ts` (`workspaceRoleForUser`, `orgAdminForUser`) |
| Workspace open | `convex/workspaces.ts` (`open`) |
| Session storage authority | `convex/sessions.ts` (`authorizeSession`, `registerRuntime`, participant and message operations) |
| RAT record/revalidation | `convex/runtimeAccessTokens.ts` |
| RAT/RHT claims and relay validation | `packages/workspace-relay/src/auth.ts`, `packages/workspace-relay/src/server.ts` |
| Runtime session policy | `packages/workspace-runtime/src/session-access-policy.ts` |
| Live/replay authorization | `packages/workspace-runtime/src/event-delivery.ts`, `packages/workspace-runtime/src/routes/events.ts` |
| Durable turn admission | `packages/agent-sdk-runtime/src/runtime.ts`, `packages/workspace-runtime/src/store.ts` |
| OpenCode projection | `packages/agent-event-runtime/src/projections/opencode-compat` |
| Central session projection | `packages/claxedo-server/src/session/runtime.ts` |
| App route authority | `packages/claxedo-app/src/app/workbench/state/route-intent.ts`, `route-bridge.tsx` |
| App session/resource authority | `packages/claxedo-app/src/features/session/store/session-resource-authority.ts`, `session-controller.ts` |
| Message projection and rendering | `packages/claxedo-app/src/features/session/conversation/opencode-conversation.ts`, `ui/message-author.tsx`, `packages/session-ui/src/components/message-part.tsx` |

## Status interpretation

- The architecture and security review is closed: all 18 validated findings in
  `review-findings.md` have implemented responses and focused evidence.
- Post-review work fixes real-provider/browser projection defects discovered by
  exercising complete user journeys. Those defects did not reopen the
  tenant-authority decisions.
- Merge and deployment readiness are separate. Read
  `verification-and-rollout.md` for the latest executed matrix and environment
  gates, then `continuation.md` for the exact next-agent orientation.
