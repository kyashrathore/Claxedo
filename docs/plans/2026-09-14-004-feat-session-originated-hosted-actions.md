# Session-originated actions on the hosted control plane: identity, renewal, and gated starts

Status: proposed; not started. Written against `merge/tasks-presets` at
`0901a478c3` (Tasks/Presets merged over dev). Follows
[`2026-09-14-001-feat-tasks-mcp-tools.md`](./2026-09-14-001-feat-tasks-mcp-tools.md)
and closes its follow-ups F1, F2 and F3.

## Goal

An agent running in a hosted cloud root can start a subagent, keep its Tasks
tools past the first half hour, and start a cloud task, with the control
plane doing each of those things on behalf of the workspace's canonical owner.
The user's framing, verbatim: "giving sandbox agent access to computer
provisioning is sure shot way of insecure worm hole". So the design has two
invariants that every slice is checked against:

1. **A sandbox never calls provisioning.** No route a sandbox credential can
   reach creates, resumes or deletes a machine. The only thing a sandbox may
   do is ask the control plane to start a task; the control plane decides,
   under rules it owns, and allocates as the owner if it decides yes.
2. **Fan-out is bounded by control-plane rules, not by agent behaviour.** Each
   rule has one owner in the control plane, is evaluated on the control
   plane's own records, and is unaffected by anything the sandbox asserts.

## Vocabulary

Terms that already exist in the code are used as written there. Two proposed
terms are introduced and labelled as proposed where they first appear:

- **Owner grant** (proposed): a control-plane-minted bearer that says "this
  workspace's runtime acts as the workspace's canonical owner", verified and
  re-resolved by the control plane on every use.
- **Agent-started root** (proposed): a cloud workspace allocated by a Start
  whose Tasks actor was a capability actor rather than a signed person.

## Trust model shared by all three slices

Observed in code, as it stands today:

- A cloud root's sessions reach the first-party MCP over loopback with an
  HS256 bearer minted by `createRuntimeCredentialIssuer`
  (`packages/workspace-runtime/src/first-party-mcp/credential.ts`). That
  bearer proves "a harness this runtime launched", nothing about a person.
- The only credential a sandbox holds that the control plane can verify is
  the Tasks capability (`packages/claxedo-server/src/tasks/capability.ts`,
  `mintTasksCapability`), placed in the readable environment on purpose
  (`workspaceRuntimeTasksCapabilityEnv` in
  `packages/claxedo-server-core/src/hosts/workspace-runtime/env.ts`: "this is
  the agent's own scoped grant, presented by tools the agent calls knowingly").
- The control plane never adopts a claim from that capability as identity:
  `capabilityTasksAuthenticate`
  (`packages/claxedo-server-core/src/tasks-host/authorization.ts`) re-reads
  `capability.workspaceOwner(scope.workspaceId)` and refuses when the owner's
  `userId`/`orgId`/`projectId` no longer match. The precedent for "act as the
  owner" is `capabilityRuntimePrincipal(grant)` in the same file, which turns
  the resolved owner into a `PrivateSessionRuntimePrincipal`
  (`{ principalKind: "user", actorId: grant.owner.actorId, actorKind: "human" }`).
- `session_create` with cloud placement from inside a session is already
  unreachable hosted: `placeOnCloud`
  (`packages/claxedo-mcp/src/tools/sessions.ts`) needs `ctx.client.controlPlane`,
  and the loopback mount built in
  `packages/claxedo-server/src/hosts/workspace-runtime/first-party-mcp.ts`
  supplies only `local` and `tasks`. Invariant 1 already holds for that tool;
  this plan keeps it holding for the new paths.

Every new grant in this plan follows the same shape as the Tasks capability:
signed with the runtime signing key (`runtimeTokenSigningKey` in
`packages/claxedo-server/src/platform/auth/runtime-token-keys.ts`), bound to
its own audience, naming one workspace, verified by the control plane and
re-resolved against `resolveWorkspaceOwner`
(`packages/claxedo-server/src/authority/adapters/d1/channel-runtime-authority.ts`)
on every use.

Since 2026-09-14 that shape has one owner, `mintSandboxPass` /
`verifySandboxPass` in `packages/claxedo-server/src/platform/auth/sandbox-pass.ts`:
standard claims (`iss`, `aud`, `sub` = user, `jti`, `iat`, `exp`), the scope
(`user_id`, `org_id`, `workspace_id`, optional `project_id` and `session_id`),
an `operations` list, and whatever claims the audience adds under its own
names. The Tasks capability and the Agent Plugins gateway token are adapters
over it, each keeping its audience, its operation vocabulary and its own
misconfiguration error. A new grant is a new audience over the same family;
renewal and revocation (by `jti`) are built once, on the family, before any
grant in this plan lands.

---

## S1 — Hosted `create_subagent` identity

### Current flow (observed)

A. The agent calls `create_subagent`.

A.1 `createSubagent` in `packages/claxedo-mcp/src/tools/subagents.ts` →
`requireParentSession(ctx)` reads `ctx.credential.sessionId` (the runtime
bearer names the session) → `parentSessionConfig` → `refuseUnsupportedChoice`
→ `createChildSession`.

A.2 `createChildSession` → `postRuntimeJson(ctx, "/session", harnessQuery, body)`
with `parentID`, `permissionCeiling` (from the credential's `permissionMode`),
`instructions`, optional `clientRequestId` → `ownWorkspaceJson` →
`ctx.client.runtime(ownWorkspaceTarget)`.

A.3 `runtime(target)` in `packages/claxedo-mcp/src/client/index.ts` returns
`local.fetch` for the served-locally target. Hosted, that fetch is
`inProcessFetch((call) => context.fetch(call))` built by
`firstPartyMcpRuntimeContribution`
(`packages/claxedo-server/src/hosts/workspace-runtime/first-party-mcp.ts`):
no headers are stamped, and the request is handed to the runtime's
contribution seam.

A.4 `context.fetch` is `contributionFetch` in
`packages/workspace-runtime/src/server.ts`: it adds the `Request` to the
`inProcessRequests` WeakSet and calls `app.fetch(request)`. The relay-host
middleware installed right below it returns early for a member of that set
(`if (inProcessRequests.has(c.req.raw)) return await next()`), so
`relayHostAuth` is never set. The contribution seam's own comment says why:
"requests handed here are recognised by identity ... the relay host-token
boundary does not [apply]" (`packages/workspace-runtime/src/route-contribution.ts`).

A.5 The runtime's session policy for a relay-exposed runtime is
`remoteWorkspaceSessionAccessPolicyFromEnv()` (`server.ts`, the `?? (loopback
|| embedded ? managedWorkspaceSessionAccessPolicy() : remote...)` selection).
`remoteWorkspaceSessionAccessPolicy`
(`packages/workspace-runtime/src/remote-session-authority.ts`) is
`managedWorkspaceSessionAccessPolicy({ requireActor: true, authority: ... })`.

A.6 `POST /session` in `packages/workspace-runtime/src/routes/session-core.ts`
(`createSessionRoutes`) runs `sessionOperationGuard(opts, c, "", "session_create")`
→ `opts.sessionAccessPolicy.authorize({ ...sessionAccessContext(c), ... })`.
`sessionAccessContext` (`packages/workspace-runtime/src/session-access-policy.ts`)
reads only `c.get("relayHostAuth")`; it is undefined here, so the input has no
`actor`, no `authority`, no `credential`.

A.7 `authorizeManaged(input, requireActor = true)` in `session-access-policy.ts`:
`!input.actor` → `{ allowed: false, status: 403, code: "session_actor_required",
message: "Managed session access requires verified actor claims" }` →
`sessionAccessDenied` → 403 JSON.

A.8 Back in the tool, `ownWorkspaceJson` throws `mcpHttpError(403, payload)`;
`surfaced` turns it into `mcpToolRefusal("session_actor_required: Managed
session access requires verified actor claims")`. That is what the agent
sees. `subagent_capabilities` fails the same way one step earlier
(`capabilities` → `session.get` → the `session_meta_read` guard).

Two more gates sit behind A.7 and would refuse a child even if an actor were
present, all in `session-core.ts`:

- `registrationOperationId(c)` reads `x-claxedo-session-registration-operation`;
  with `managedRegistration(opts)` true (policy is `managed-private`) and no
  header or no `body.id`, the route answers 400 `session_reservation_required`.
  The header is set today only by callers that reserved first: the app
  (`packages/claxedo-app/src/features/session/composer/ui/submit-create-session.ts`,
  `packages/claxedo-app/src/platform/runtime/private-session-reservation.ts`),
  the control plane's `machine-dispatch.ts` `create`
  (`packages/claxedo-server/src/session/machine-dispatch.ts`, which calls
  `authority.reserveRuntimeSession(runtimeActor, intent)` or `reserveSession(caller, intent)`
  and then dispatches with the header), and the Tasks bridge's
  `createTasksSessionReserve` (`packages/claxedo-server/src/tasks/session-reservation.ts`).
- `registerCreatedSession` → `policy.registerSession(input)` → the remote
  policy's `request(input, "register", ...)` requires `input.credential` (the
  request's `authorization` header, forwarded verbatim) and otherwise answers
  503 `session_authority_unavailable`. On the control plane,
  `RuntimeSessionAuthorityRoutes` (`packages/claxedo-server/src/routes/runtime-session-authority.ts`,
  `verifySessionProof`) accepts that bearer only as a Relay Host Token
  (`relayProofVerifier`, issuer `workspace-relay`, audience
  `workspace-host-service`) or as a stream/turn lease, maps it through
  `privateSessionRuntimeProof` to a `PrivateSessionRuntimePrincipal`, and calls
  `authority.registerRuntimeSession({ ...principal, operationId, sessionId, workspaceId })`.

Where the reservation itself is decided: `reserveRuntimeSession(principal, input)`
on the `PrivateSessionAuthority` contract
(`packages/claxedo-server-core/src/platform/auth/private-session-authority.ts`),
implemented by `D1SessionAuthority.reserveRuntimeSession`
(`packages/claxedo-server/src/authority/adapters/d1/session-authority.ts`),
which calls the private `requireRuntimeActor(principal)` (the actor row must
exist, be active, be of the claimed kind, and belong to an active user) and
then `reserveForActor(who, input)` → `requireWorkspaceAccess(who, workspaceId, "write")`.
The reservation records the creator actor; a session reserved for anyone but
that person is one they cannot open (the comment on `TasksSessionReserveInput.principal`
in `session-reservation.ts` says exactly this).

Where the runtime's issuer is built without an identity:
`claxedoWorkspaceRuntimeBootFromEnv` in
`packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts` calls
`createRuntimeCredentialIssuer({ runtimeId: randomUUID(), workspaceId })`. The
issuer accepts an optional `userId` (`RuntimeCredentialIssuerOptions.userId`,
carried as `user_id` and surfaced as `McpCredential.userId`), and nothing
supplies it hosted. It is not the cause of the 403 (the runtime's policy never
reads the MCP credential), but it is why hosted MCP audit records name
`runtime:<id>` instead of the owner (`mcpAuditRecord` in
`packages/claxedo-mcp/src/server.ts`).

Where the control plane already knows the owner: `prepareRuntime` in
`packages/claxedo-server/src/agent-plugins/hosted-composition.ts` reads
`activations.runtimeSnapshot(workspaceId)`
(`packages/claxedo-server/src/agent-plugins/activation/d1-store.ts`, owner =
`workspaces.owner_user_id`) and hands `{ userId, orgId, projectId, workspaceId }`
to `createCloudRootEnvironment`
(`packages/claxedo-server/src/agent-plugins/runtime/cloud-root-environment.ts`),
which mints the Tasks capability through `createTasksRootCapability`
(`packages/claxedo-server/src/tasks/root-capability.ts`) when the Tasks group
is on. The owner's actor id is resolved by `resolveWorkspaceOwner` at request
time, never written into the environment.

### Why "stamp any actor" is a privilege bypass

The two-line version would read an actor id from the in-process request (a
header, a body field, or the runtime credential's `user_id`) and set
`relayHostAuth` from it. Concretely that would let a runtime, and therefore
anything that can reach the runtime's loopback port from inside the sandbox
with the harness's own MCP bearer (the agent has `shell` and `pty_write` on
that machine), do the following:

- name any active actor in the organization as the creator of a child session
  (`reserveRuntimeSession` → `requireRuntimeActor` only checks that the actor
  row exists and is active; it has no proof of possession);
- pass `authorizeSessionRead`/`authorizeSessionWrite` on the control plane
  as that actor, which is what `readSession`, `message_read`, `prompt`,
  `permission_response`, `session_config_write` and the event stream
  (`authorizeStream`) are gated on, so it could read and drive another
  participant's private session in the same workspace;
- acquire turn leases as that actor (`acquireTurn`), fencing a person out of
  their own session;
- write MCP audit records under a name the runtime chose.

The control plane would be asked "is actor X allowed?" and would answer
truthfully about X; the lie is that the runtime is X. The fix is that the
runtime never chooses an actor: it presents a control-plane-minted bearer
that names one workspace, and the control plane resolves the actor from its
own `workspaces.owner_user_id` row on every use.

### Design

**S1.a Owner grant (proposed) minted at root preparation.** New module
`packages/claxedo-server/src/session/owner-grant.ts` beside the Tasks
capability minter, same signing key, same TTL cap:

- `mintOwnerGrant({ workspaceId, orgId, userId, actorId }, signingEnv, { ttlSeconds? })`
  → JWT `{ workspace_id, org_id, user_id, actor_id }`, issuer
  `claxedo-control-plane`, audience `workspace-runtime-owner`, subject
  `userId`, `jti`, `exp` = min(60 min, requested), default 30 min.
- `verifyOwnerGrant(token, env)` → the scope or throws.
- Env: `WORKSPACE_RUNTIME_OWNER_GRANT` and `workspaceRuntimeOwnerGrantEnv` in
  `packages/claxedo-server-core/src/hosts/workspace-runtime/env.ts`.

`createCloudRootEnvironment` mints it when the **`subagents`** tool group is
enabled for the root (the same `enabledBuiltinGroups` read that gates the
Tasks grant on the Tasks group). Consent and credential stay one act: a
project with subagents off launches roots that cannot act as their owner.
The owner's `actorId` comes from `resolveWorkspaceOwner(workspaceId)` at mint
time (the `CloudRootIdentity` type gains nothing; the minter takes the
`TasksCapabilityOwner` shape which already carries `actorId`).

Issuer choice: `claxedo-control-plane` rather than the relay's
`runtimeAccessTokenIssuer`, because the runtime verifies this one itself
(S1.c) with the management key it already trusts
(`WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL` / `_VERIFY_PEM`, issuer
`claxedo-control-plane`, wired by `controlPlaneVerificationEnv` in
`packages/claxedo-server/src/workspace/supervisor/runtime-env.ts` and
`sandboxRuntimeControlEnv` in
`packages/claxedo-server/src/authority/adapters/worker/hosted-sandbox-driver.ts`).

**S1.b Runtime boot reads the grant.** `runtime-boot.ts` reads
`WORKSPACE_RUNTIME_OWNER_GRANT`; parses `user_id` without verification only to
seed `createRuntimeCredentialIssuer({ userId })` (this is the same trust the
Tasks capability already gets from the environment, and the MCP credential's
`userId` is informational: audit and `mcpAuditRecord.actor`). The token itself
is handed to `firstPartyMcpRuntimeContribution` as `ownerGrant: () => string | undefined`
(a reader, so S2's renewal can swap it), and the contribution stamps it on the
in-process fetch: `inProcessFetch(handle, { authorization: `Bearer ${grant}` })`
(the helper already accepts stamped headers).

**S1.c The runtime kit accepts the owner grant as the in-process actor.**
Change point in `packages/workspace-runtime/src/server.ts`, the middleware
that today returns early for `inProcessRequests`: an in-process request that
carries an `authorization` bearer is passed through a new
`ownerGrantIdentity(token)` (new module
`packages/workspace-runtime/src/owner-grant.ts`) that verifies it with the
management key (`loadWorkspaceRuntimeManagementVerificationKey` in
`management-auth.ts`, issuer `claxedo-control-plane`, audience
`workspace-runtime-owner`), requires `workspace_id === options.target.workspaceId`,
and on success sets `relayHostAuth` to an `EmbeddedRelayHostIdentity`
(`workspace-host-service-auth.ts` already defines the type for "verified actor
identity stamped by the in-process boundary"):
`{ principal_kind: "user", actor_id, actor_kind: "human", actor_public_id: actor_id, actor_name: "workspace owner", org_id, workspace_id, role: "owner" }`.
A bearer that does not verify is not an error for in-process traffic; the
request proceeds with no actor, exactly as today. Nothing else about the seam
changes: a contribution still cannot name an actor, it can only present the
grant the control plane minted for this workspace, and the control plane
re-verifies that same bearer at every authority call (S1.e).

`sessionAccessContext` then yields `actor`, `authority` and `credential` for
the child create, and A.7 passes.

**S1.d The child create reserves itself.** In `session-core.ts` `POST /session`,
after the parent checks and only when `body.parentID` is set,
`managedRegistration(opts)` is true, no operation header was sent, and the
policy exposes a new optional member `reserveSession`, the route calls
`opts.sessionAccessPolicy.reserveSession({ ...sessionAccessContext(c), sessionId, workspaceId, parentSessionId: body.parentID, title })`
where `sessionId` is `body.id` (derived from `clientRequestId` when given) or
`ses_<uuid>`. The decision returns `{ allowed: true, operationId }`; the route
continues as if the header had carried it. An ordinary create (no `parentID`)
keeps requiring the caller's own reservation; self-reservation is scoped to
children so the app's and the control plane's create paths are unchanged.

`remote-session-authority.ts` adds the action `"reserve"` (body
`{ sessionId, action, parentSessionId, title }`, credential = the request's
authorization header, decoder `decodeReservation` reading `operationId`).
`SessionAccessPolicy.reserveSession?` is typed in `session-access-policy.ts`
next to `registerSession`; the loopback/embedded flavour has none.

The existing child rules run before and after this, unchanged:
`subagent_recursion_denied` (a child cannot create children),
`parent_session_archived`, `subagent_child_cap_reached` at
`MAX_ACTIVE_CHILDREN_PER_PARENT`, the permission ceiling narrowing
(`effectivePermissionCeiling` / `narrowerPermissionLevel` /
`permissionModeUnderCeiling`), and `children.withCreation` serialisation.

**S1.e The control plane accepts the owner grant as a proof and adds `reserve`.**
`verifySessionProof` in `runtime-session-authority.ts` gains a third branch,
tried before the relay proof: `verifyOwnerGrant(token, env)` → then
`resolveWorkspaceOwner(scope.workspace_id)` must return an owner whose
`userId` and `actorId` equal the grant's claims and whose `orgId` equals
`org_id`, else 401 `owner_grant_invalid`. The resulting claims are
`{ principalKind: "user", actorId, actorKind: "human", transport: "owner-grant", orgId, workspaceId, hostId: workspaceId, ... }`.
The `register`, `registration_ambiguous`, `compensation_*`, `read`, `write`
and `turn_*` actions then run through `sessionLeasePrincipal` as they do for
a human's Relay Host Token. `runtimeAccessTokenDenial` does not apply
(`transport !== "relay-host"`); the recheck for this transport is the owner
re-resolution above, performed on every call.

New action `reserve`: accepted only for `transport: "owner-grant"`; requires
`parentSessionId`; calls `authority.authorizeRuntimeSession({ ...principal, sessionId: parentSessionId, workspaceId, action: "read" })`
(the owner must be able to open the parent; a parent created by another
participant that the owner cannot read is refused with 403 `session_private`),
then `authority.reserveRuntimeSession(principal, { operationId: `session_registration_${uuid}`, sessionId, workspaceId, kind: "create", parentSessionId, title })`
and answers `{ allowed: true, operationId }`. `ReservePrivateSessionInput`
already carries `parentSessionId`; `reserveForActor` in the D1 adapter reads
it only for `kind: "fork"`, and that stays as is (the parent read above is the
rule for children).

**S1.f Contract change on `RuntimeSessionAuthorityOptions`.** The route needs
`resolveWorkspaceOwner` and the signing env; both are already on the
composition that mounts it (the D1 authority and `stringEnvironment(env)` in
`packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts`).

### What stays unchanged

- Local and embedded runtimes: policy is `managedWorkspaceSessionAccessPolicy()`
  with no `requireActor`; `create_subagent` already works there
  (`packages/claxedo-local-server/src/app/first-party-mcp-subagents.live.test.ts`).
- The app's own child creation and the control plane's `machine-dispatch.ts`
  path (they reserve first and send the header).
- The permission ceiling, depth (`subagent_recursion_denied`) and cap
  (`MAX_ACTIVE_CHILDREN_PER_PARENT`, mirrored as `MAX_ACTIVE_CHILDREN` in
  the tool) rules.
- The Relay Host Token path and its `runtimeAccessTokenActive` recheck.

### Rejected alternative

Routing the child create through the control plane (`machine-dispatch.ts`
`create` with `runtimeActor` = the owner's human actor, dispatched back into
the runtime over the relay with a real RHT). It satisfies the invariants with
no new proof kind, but it moves a create that the runtime already serialises
in-process (`children.withCreation`, `admitCreated`) out through the relay and
back, doubles the hops for every child, and makes the loopback mount depend on
a control-plane fetch it deliberately does not have. The owner grant keeps the
create in-process and adds one proof kind that reuses the existing
re-resolution rule.

### Acceptance criteria

- On hosted staging, a session in a cloud root with the subagents group on
  calls `create_subagent`; the tool returns `{ kind: "claxedo.subagent", sessionId, subagentKey }`;
  the child appears under the parent in the app and opens for the owner
  (creator actor = the owner's human actor).
- With the subagents group off for the project, the root has no owner grant;
  `create_subagent` answers the existing 403 sentence and nothing is reserved.
- A grant for workspace A presented to workspace B's runtime is ignored
  (`workspace_id` mismatch → no actor). The same grant presented to the
  control plane's authority route for a session in workspace B is refused.
- A grant whose workspace was re-owned is refused at `reserve` and at
  `register` (owner re-resolution), and the runtime's in-process create fails
  with the authority's refusal, compensated through the existing
  `compensateRegistration` path.
- A child cannot create a child; the fifth active child is refused; the
  child's permission mode is narrowed to the parent's ceiling. Unchanged
  tests stay green.

### Tests

- `packages/claxedo-server/src/session/owner-grant.test.ts` (new): mint/verify
  round trip, expiry, wrong audience (a Tasks capability is refused as an owner
  grant and vice versa), tampered payload.
- `packages/claxedo-server/src/agent-plugins/runtime/cloud-root-environment.test.ts`:
  the grant is present only when the subagents group is on; absent otherwise.
- `packages/claxedo-server/src/routes/runtime-session-authority.test.ts`:
  owner-grant proof accepted for `reserve`/`register`/`read`/`write`; refused
  on owner mismatch; `reserve` refused when the parent is not readable by the
  owner; `reserve` refused for a relay-host proof.
- `packages/workspace-runtime/src/owner-grant.test.ts` (new): verification
  with a static PEM, workspace mismatch → no identity.
- `packages/workspace-runtime/src/remote-session-authority.test.ts`: the
  `reserve` action body and decoder.
- `packages/workspace-runtime/src/routes/session-children.routes.test.ts`:
  an in-process child create with a stamped identity self-reserves and
  registers; without an identity it still answers 403 `session_actor_required`;
  an ordinary create without a header still answers `session_reservation_required`.
- `packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.test.ts`
  and `first-party-mcp.test.ts`: the issuer carries the owner's `userId`; the
  in-process fetch stamps the grant.
- `packages/claxedo-mcp/src/tools/subagents.test.ts`: unchanged behaviour;
  audit record `actor` is the owner when the credential carries `userId`.
- Live: hosted staging as in the acceptance criteria; record the child's
  creator actor from the D1 `sessions` row.

### Definition of Done — S1

- [ ] Owner grant minter/verifier with tests; env constant and helper. Progress:
- [ ] Root environment mints the grant when the subagents group is on. Progress:
- [ ] Runtime kit verifies the grant on in-process requests and stamps `EmbeddedRelayHostIdentity`. Progress:
- [ ] `reserveSession` policy member, `reserve` remote action, child self-reservation in `POST /session`. Progress:
- [ ] Control plane accepts the owner-grant proof with owner re-resolution; `reserve` action. Progress:
- [ ] Runtime host boots the issuer with the owner `userId` and stamps the grant on the MCP contribution's fetch. Progress:
- [ ] Package tests, root typecheck, `bun run test:architecture-ratchets`, lint green. Progress:
- [ ] Live proof on hosted staging recorded under `docs/verification/tasks/`. Progress:

---

## S2 — Tasks capability renewal

### Current flow (observed)

B. A cloud root is provisioned.

B.1 `prepareRuntime` (`agent-plugins/hosted-composition.ts`) →
`rootEnvironment({ userId, orgId, projectId, workspaceId })` =
`createCloudRootEnvironment` → `enabledBuiltinGroups` (per group:
`activations.readRuntime(...)` then `resolveBuiltinGroupActivation({ group, harnessId: "opencode", deployment, mode: "signed", projectOverride, userDefault, organizationDefault })`
in `packages/claxedo-server-core/src/agent-plugins/builtin/plugin.ts`) → if
`BUILTIN_TASKS_TOOL_GROUP` is on, `input.tasksGrant(root)`.

B.2 `tasksGrant` is `createTasksRootCapability({ signingEnv })`
(`packages/claxedo-server/src/tasks/root-capability.ts`): operations
`["read", "create"]`, plus `"start"` when
`crossMachineWrites({ userId, orgId })` is true. The production composition
(`better-auth-d1-candidate-worker.agent-plugins.cf.ts`) passes no reader, so
`crossMachineWritesOff` applies and no hosted grant carries `start`.
`mintTasksCapability` (`tasks/capability.ts`): `DEFAULT_TTL_SECONDS = 30 * 60`,
`MAX_TTL_SECONDS = 60 * 60`, `ttl = min(MAX, max(60, requested))`. The gateway
token in `packages/claxedo-server/src/agent-plugins/mcp/runtime-token.ts` has
the same two constants (lines 14–15), which is the symmetry the first plan
asked for. The result is `workspaceRuntimeTasksCapabilityEnv({ token, operations, projectId })`.

B.3 The Tasks bridge's cloud Start reaches the same minter through
`input.capability(root, auth)` in `createTasksCloudTarget`
(`packages/claxedo-server/src/tasks/session-bridge.ts`), which
`hostedTasksRouteContributions` wires to `feature.rootEnvironment`.

C. The runtime boots.

C.1 `claxedoWorkspaceRuntimeBootFromEnv` → `workspaceRuntimeTasksGrant(env)`
(`packages/claxedo-server/src/hosts/workspace-runtime/tasks-grant.ts`) reads
`WORKSPACE_RUNTIME_TASKS_CAPABILITY`, `_OPERATIONS`, `_PROJECT` once and
returns `{ operations, projectId, fetch }` where `fetch` stamps
`authorization: Bearer ${token}` on every call to `controlPlaneOrigin(env)`
(the origin of `WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL`). The token is a
`const` in a closure. Nothing renews it.

C.2 `firstPartyMcpRuntimeContribution({ tasks })` → each MCP session's
`createClient` gets the same `tasks` object → `assertToolAccess(credential,
name, access, granted)` reads `granted` from the client's `tasks.operations`
(`packages/claxedo-mcp/src/context.ts`).

D. The agent calls `task_list` after 30 minutes.

D.1 `tasks/http/routes.ts` → `capabilityTasksAuthenticate` →
`capability.verify(token)` = `verifyTasksCapability` → jose `jwtVerify`
throws on `exp` → `.catch(() => undefined)` → falls through to
`input.signed(request)` → 401 "This request is not signed" → the tool's
`tasksRefusals` renders it. Every session in that root, new ones included,
loses the tools (F2 in the first plan; finding 7 in the Codex review).

E. How the runtime reaches the control plane after boot (observed, and where
the brief's description does not match the code):

- There is no checkpoint push. Checkpoints are pulled: the control plane
  calls the runtime's `/api/wr/checkpoint/*` routes
  (`packages/claxedo-server/src/workspace/checkpoints.ts`) with a service
  Relay Host Token.
- There is no `openWorkspace` in the runtime host; that name exists only in
  the local server and the perf harness.
- Session registration (`register`, compensation, turn leases) is a
  per-request POST to `WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL` carrying the
  **caller's** bearer (`input.credential`), so it identifies a person or the
  control plane's service actor, never the runtime.
- The relay host tunnel (`startWorkspaceRelayHostTunnel`, env
  `WORKSPACE_RUNTIME_RELAY_TUNNEL_TOKEN`) authenticates the runtime to the
  relay, not to the control plane.
- Config apply is inbound: the control plane pushes `POST /api/wr/config`
  with a management JWT verified against its own JWKS
  (`ConfigRoutes`, `WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER`).

The one runtime-originated channel to the control plane is the Tasks grant's
own `fetch`. Renewal therefore rides that channel.

### Design

**S2.a Renew route on the control plane.** New module
`packages/claxedo-server/src/tasks/grant-renewal.ts` exporting a
`ControlPlaneRouteContribution` mounted at `${TASKS_ROUTE_PATH}/grant/renew`
(`TASKS_ROUTE_PATH` from `@claxedo/tasks/http`). It is not admitted through
`capabilityTasksAuthenticate` (whose `tasksRequestCost` table would refuse an
unknown POST); it authenticates itself:

1. `verifyTasksCapability(bearer, signingEnv)`; an expired, tampered or
   signed-user bearer is 401 `tasks_grant_invalid`. Expired tokens are not
   accepted for renewal; the window is the token's own lifetime.
2. `resolveWorkspaceOwner(scope.workspaceId)`; refuse 403
   `tasks_grant_owner_changed` when absent or when `userId`/`orgId`/`projectId`
   differ from the scope.
3. Re-read the Tasks group's activation for the root through the same
   `enabledBuiltinGroups` reading `createCloudRootEnvironment` uses (the lane
   extracts `tasksGroupEnabled(root)` from it); refuse 403
   `tasks_group_disabled` when off.
4. Re-mint through `createTasksRootCapability` (so `crossMachineWrites` is
   re-read and `start` can appear or disappear), same `workspaceId`,
   `projectId`, `sessionId` (if the old scope had one) → `{ token, operations, expiresAt }`.
5. When S1 has landed: the same request also re-issues the owner grant when
   the subagents group is on; the response carries both. One owner
   resolution, one activation read, two tokens.

The route's audit record names the workspace, the owner and the operations
granted, as `mcpAuditRecord` does.

**S2.b Runtime-side renewal in `tasks-grant.ts`.** `workspaceRuntimeTasksGrant`
becomes a small object with a mutable `token`, `operations`, `expiresAt`
(read from the token's `exp` without verification; the control plane verifies)
and a `renew()` loop started by the host after boot:

- schedule at half-life (`expiresAt - now) / 2`, the rule
  `createRuntimeCredentialIssuer` already applies to its own token);
- on failure retry with backoff (2 s doubling, capped at 60 s) until
  `expiresAt`;
- on success swap `token`, `operations`, `expiresAt` in place and reschedule;
- on a 403 from steps 2–3, stop renewing and mark the grant `withdrawn`
  with the route's message.

`TasksGrant.fetch` reads the live `token`. A request made after `expiresAt`
with no renewed token is answered locally with
`{ error: { code: "tasks_grant_lapsed", message } }` (503) without a round
trip; `tasksRefusals` in `packages/claxedo-mcp/src/tools/tasks.ts` turns it
into the sentence below.

`firstPartyMcpRuntimeContribution` takes `tasks: () => TasksGrant | undefined`
(a reader) and calls it inside `createClient`, so each new MCP session sees
the current `operations`; an MCP session opened before a renewal keeps its
`tools/list` until it reconnects, and the control plane's
`capabilityTasksAuthenticate` remains the boundary for an operation the
renewed scope no longer carries.

**S2.c Composition.** `better-auth-d1-candidate-worker.agent-plugins.cf.ts`
mounts the renewal contribution with `{ signingEnv, workspaceOwner: authority.resolveWorkspaceOwner, tasksGroupEnabled, mint: createTasksRootCapability({ signingEnv, crossMachineWrites }) }`.
The `crossMachineWrites` reader is S3 gate 1's; until it lands the composition
passes none and renewed grants keep `["read", "create"]`, exactly as minted
today.

### Failure modes and what the agent sees

| Situation | Control plane | Runtime | Agent sees |
| --- | --- | --- | --- |
| Control plane unreachable at half-life, reachable before expiry | — | retries until a renewal lands | nothing; tools keep working |
| Unreachable until expiry | — | grant `lapsed`; `fetch` answers 503 locally; new MCP sessions get no Tasks client | "This machine's Tasks grant has expired and could not be renewed; it is re-issued the next time the machine is provisioned." New sessions: no `task_*` tools. Recovery is the next `prepareRuntime` (wake, restore, Start), which mints fresh environment; a running runtime never recovers on its own — see the later item |
| Tasks switch turned off mid-life | renewal refused `tasks_group_disabled`; the outstanding token stays valid until its `exp` (no denylist) | stops renewing; marks `withdrawn` | tools keep working for at most the remaining TTL (≤ 30 min), then "Tasks was turned off for this project." Immediate revocation is the later item |
| Cross-machine setting turned off mid-life | renewal re-mints without `start` | new MCP sessions list no `task_start`; old ones still list it | a `task_start` call is refused by the control plane: "This session's Tasks grant does not allow start" |
| Workspace re-owned, owner suspended or deleted | every Tasks request already refused by `capabilityTasksAuthenticate` (owner recheck); renewal refused `tasks_grant_owner_changed` | marks `withdrawn` | "This session's workspace no longer answers for the grant it carries." (existing sentence) |
| Root restarted (checkpoint restore, wake) | `prepareRuntime` mints a fresh grant | boots with it | nothing |

Later items (named, not built here): a control-plane-initiated re-issue over
the management config channel for a running runtime whose grant lapsed; a
`jti` denylist for immediate withdrawal when the switch goes off.

### What stays unchanged

`mintTasksCapability` and `verifyTasksCapability`; the expiry check; the
Tasks routes' admission (`capabilityTasksAuthenticate`, `tasksRequestCost`);
the local server (`local-app.ts` supplies `tasks: { fetch: localFetch, operations: TASKS_OPERATIONS }`,
no token); the self-hosted signed node's grants (`tasks/session-grants.ts`).

### Acceptance criteria

- A cloud root on staging left idle for 40 minutes answers `task_list` from a
  session opened at minute 35 and from one opened at minute 5.
- With the renewal route blocked (staging egress rule or a fault injected in
  the reader), the grant lapses at expiry; the refusal sentence is the one
  above; a new session has no `task_*` tools; re-provisioning restores them.
- Turning the Tasks switch off makes the next renewal 403; the tools stop
  within one TTL.
- A renewal request with a signed user bearer, an owner grant, or an expired
  capability is refused; the route never mints for a workspace whose owner
  differs from the scope.

### Tests

- `packages/claxedo-server/src/tasks/grant-renewal.test.ts` (new): the six
  refusals and the success path against the real `mintTasksCapability`/
  `verifyTasksCapability`; `start` appears when the reader says yes and
  disappears when it says no; the owner grant rides along when subagents is on.
- `packages/claxedo-server/src/hosts/workspace-runtime/tasks-grant.test.ts`:
  half-life scheduling with a fake clock, retry until expiry, in-place swap,
  local 503 after lapse, `withdrawn` after a 403.
- `packages/claxedo-server/src/hosts/workspace-runtime/first-party-mcp.test.ts`:
  a client created after a swap sees the new `operations`.
- `packages/claxedo-server/src/deployments/hosted-shared/app.sandbox-credential-scope.test.ts`:
  the renew route is admitted to a capability bearer and to nothing else;
  this is the route-admission matrix the Codex review asked to be made real
  (finding 10), so the lane fixes the fixture to a strict accepted-token set
  for at least this route.
- Live: the 40-minute staging proof, recorded with the runtime log lines
  `tasks.grant.renewed` / `tasks.grant.lapsed`.

### Definition of Done — S2

- [ ] Renewal route with owner re-resolution, activation re-read and re-mint; tests. Progress:
- [ ] Runtime grant object with half-life renewal, retry, lapse and withdrawal; tests. Progress:
- [ ] MCP contribution reads the grant per client; tests. Progress:
- [ ] Route-admission test covers the renew route with a strict token fixture. Progress:
- [ ] Composition wiring in the worker entry. Progress:
- [ ] Package tests, root typecheck, ratchets, lint green. Progress:
- [ ] 40-minute staging proof recorded. Progress:

---

## S3 — Gated cloud Start from inside a session (F1)

### Current flow (observed)

F. The agent calls `task_start` on a cloud preset from a hosted session.

F.1 `task_start` (`packages/claxedo-mcp/src/tools/tasks.ts`) →
`assertToolAccess(..., operation: "start")` → refused today with "needs the
start Tasks operation, which this session was not granted", because no hosted
grant carries `start` (B.2). Assume for the rest of the trace that it does.

F.2 `client.startPreview(task, ...)` → `POST ${TASKS_ROUTE_PATH}/:task/start-preview`
→ `capabilityTasksAuthenticate` (operation `start` per `tasksRequestCost`) →
`principals.capabilityActorOf({ scope, owner })` → the kit's preview →
`identity.bridge(...)` = `confineCapabilityBridge(principals, capability, bridge)`
(`tasks-host/contribution.ts` line 83) → `capabilityScopeRefusal` on the
task's `workspaceId` → `createTasksSessionBridge(...).preview` →
`resolveStart` (`packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts`)
→ `execution.placement === "cloud"` → `cloudTarget(host, command, capabilities)`
→ `host.cloudTarget(origin)`.

F.3 `host.cloudTarget` is `createTasksCloudTarget(input)` in
`packages/claxedo-server/src/tasks/session-bridge.ts`. `input.auth(origin.actor)`
= `identity.principals.authOf(actor)`, which is undefined for a capability
actor (the registry holds grants for them, not signed principals). Then
`allocateOriginCloudWorkspace` (`packages/claxedo-server/src/workspace/origin-cloud-workspace.ts`)
→ `allocate` → `ensureWorkspace` store row → `admit(workspace, input)` →
`input.admit` throws `"this host creates a cloud root as the person starting it, and this caller is not signed"`
→ `admit` deletes the store row and returns
`{ code: "source_unavailable", detail: "This caller may not create a cloud workspace here: ..." }`
→ the preview carries that blocker → the tool refuses with the blocker's
detail. No sandbox is created.

Where a signed person's Start succeeds instead: `admit` calls
`requireAuthority(services).createCloudWorkspace(auth, { workspaceId, projectId, ... })`
→ D1 `createCloudWorkspace` → `createWorkspace(auth, {...orgId: creationOrgId(auth, projectId), backing: "cloud-vm", access: "cloud"})`
→ `requirePrincipal(auth)` → `canAdminOrganization(who.userId, orgId)` →
the row; `discard` calls `deleteWorkspace(auth, ...)`; `prepare` mints the
root's environment with `auth.principal.userId` as owner; then
`awaitSandboxReady` → `sandboxManager.ensure(...)` is the one call that
creates a machine, and it is reached only from this function, on the control
plane, after `admit` succeeded.

### Design (a): the gates, in order, each a control-plane rule with one owner

The gates run for capability actors only. A signed person's Start from the
app is not touched by any of them.

**Gate 1 — `start` in a grant only when the account's cross-machine setting is on.**
Owner: `createTasksRootCapability` (already reads a `CrossMachineWrites`).
What is missing is the reader. `cross-machine-writes.ts` records that "no
deployment stores it yet". This slice adds the store:

- D1 migration `packages/claxedo-server/migrations/control-plane/0026_agent_cross_machine_writes.sql`:
  `user_agent_settings (user_id text primary key, cross_machine_writes integer not null default 0, updated_at integer not null)`.
- Reader `packages/claxedo-server/src/authority/adapters/d1/agent-settings.ts`:
  `d1CrossMachineWrites(database): CrossMachineWrites` (a row with 1 → true;
  absent → false).
- Signed routes `GET/PUT /api/account/agent-settings` in
  `packages/claxedo-server/src/routes/account-agent-settings.ts`, following
  `routes/remote-access.ts` for shape; PUT is the person's own row only.
- App: one row in Settings, "Agents may act on my other machines", off by
  default (`packages/claxedo-app/src/features/settings/**`; the lane locates
  the Settings section that owns account rows). The `FirstPartyMcpOptions.crossMachineWrites`
  reader on the hosted user-credential mount gets the same source.

Effect: a grant carries `start` only for an owner who turned this on, and S2's
renewal re-reads it.

**Gate 2 — project scope.** Already in place: `capabilityTasksAuthenticate`
refuses a project outside the scope; `confineCapabilityBridge` refuses a task
whose stored `workspaceId` is outside the scope's project. Unchanged.

**Gate 3 — chain depth.** Owner: a new bridge decorator
`gateAgentStarts(...)` in `packages/claxedo-server-core/src/tasks-host/agent-start-gates.ts`,
composed in `signedTasksIdentity`'s `bridge` next to `confineCapabilityBridge`.

Definition (proposed): `agentStartDepth(task)`:
- `task.createdFrom === null` (a person created it in the app) → 0.
- otherwise find the link whose `sessionRef.sessionId === task.createdFrom.sessionId`
  through a new store operation `links.bySession(scopeId, sessionId)`; none →
  1 (created by an ordinary session's agent); found → `1 + agentStartDepth(task of that link)`.
- The walk stops after `MAX_AGENT_START_CHAIN_DEPTH + 1` hops and treats a
  longer chain as over the limit, so no cycle or long history can make it
  unbounded.

Rule: a capability actor may preview or start a **cloud** preset only when
`agentStartDepth(task) <= MAX_AGENT_START_CHAIN_DEPTH`, with the constant 1.
Read out: a person starts task A (depth 0) on a cloud root R1; R1's session
creates task B (depth 1) and may start it on R2; R2's session creates task C
(depth 2) and is refused: "Task C is two machines away from the person who
started this chain; start it from the app." Local presets are not depth-gated
(they run in the task's own workspace and allocate nothing).

**Gate 4 — per-project cap on concurrent agent-started cloud roots.** Owner:
the same decorator. `TaskSessionLink` gains `startedFrom: SessionReference | null`
(the session whose agent started the attempt; set by the bridge from the
grant's `scope.sessionId`, never from the request) and `placement: "local" | "cloud"`
at start. Count = links in the project with `startedFrom !== null` and
`placement === "cloud"` whose session is neither archived nor deleted per
`host.sessionMetas` (the liveness the bridge already computes). Rule: a
capability actor's cloud preview/start is refused when the count is at
`MAX_AGENT_STARTED_CLOUD_ROOTS_PER_PROJECT`, constant 4 (the same number the
subagent cap uses), with the sentence naming the count and the project. The
proxy counts sessions, not sandboxes: a finished root whose session is still
open counts until it is archived. That is the honest limit of what Tasks can
see; sandbox budgets are the later item.

**Gate 5 — per-preset flag.** Name: `agentStartable`. In
`packages/claxedo-tasks/src/contracts.ts`: `Preset.agentStartable: boolean`
and `PresetDraft.agentStartable: boolean` (so `preset.create` and
`preset.edit` carry it; `decode.ts`, `validation.ts`, `presets/model.ts`
validate a boolean). Stores: memory, `sqlite-store.ts`/`tasks.sql.ts`
(`agent_startable integer not null default 0`, the local migration
`packages/claxedo-server-core/src/platform/db/claxedo-migration/20260912100000_claxedo_tasks/migration.sql`
edited in place), D1 `d1-store.ts` and `0025_claxedo_tasks.sql` edited in
place (both unreleased on this branch), conformance case in
`packages/claxedo-tasks/src/conformance/store.ts`. Default false. Rule: a
capability actor's preview/start with `preset.agentStartable === false` is
refused with `tasksErrorDetail("forbidden", "Preset <name> is not marked as startable by agents; a person can mark it in Settings → Presets")`.
UI: a checkbox "Agents may start this preset from a session" in
`packages/claxedo-app/src/features/tasks/ui/presets/preset-draft-editor.tsx`
and its model `preset-editor-model.ts`; the presets list shows a small mark
when set.

**Gate 6 — budgets and rate limits (later item, named).** Per-account minute
budgets for agent-started roots and a per-session start rate belong with the
sandbox lease accounting, not with Tasks; recorded here so the cap above is
not mistaken for a budget.

Order of evaluation in the decorator: 5 (flag) → 3 (depth) → 4 (cap). All
three are evaluated at preview and again at start (a preview digest does not
carry them, and the world can change between the two calls). Refusals are
`TasksFailure`s, as `confineCapabilityBridge` produces, not `StartBlocker`s:
the blocker vocabulary (`START_BLOCKER_CODES`) describes the destination, and
these describe the caller.

### Design (b): allocation as the owner, after the gates

**Authority operation.** `WorkspaceAuthority`
(`packages/claxedo-server-core/src/platform/auth/authority.ts`) gains two
optional members mirroring `reserveRuntimeSession`'s shape:

```ts
createRuntimeCloudWorkspace?: (
  principal: PrivateSessionRuntimePrincipal,
  args: { workspaceId: string; orgId: string; projectId: string; displayName: string;
          repoUrl?: string; repoName?: string; gitBranch?: string; homeRegion?: string },
) => Promise<unknown>
deleteRuntimeWorkspace?: (principal: PrivateSessionRuntimePrincipal, args: { workspaceId: string }) => Promise<unknown>
```

D1 implementation in `authority/adapters/d1/workspace-authority.ts`:
`requireRuntimeActor(principal)` (the same check the session authority
applies: active human actor of an active user) → `authorizeProjectFor(who, projectId, "admin")`
(the `who`-based half of `creationOrgId`, extracted so the signed path and
this one share it) → the existing body of `createWorkspace` moved into
`createWorkspaceAs(who, input)` and called from both `createWorkspace(auth, ...)`
and this operation. `canAdminOrganization(who.userId, orgId)` still applies:
an owner who could not create a cloud workspace from the app cannot have one
created for them here. `deleteRuntimeWorkspace` is the `who`-based half of
`deleteWorkspace` the same way.

**Bridge.** `HostedTasksSessionBridgeInput` gains
`owner?: (actor: TasksActor) => TasksCapabilityOwner | undefined` (from
`identity.principals.capabilityOf(actor)?.owner`), and `capability` drops its
unused `auth` parameter (`rootEnvironment` never took one). `createTasksCloudTarget`:

- `auth` present → unchanged path.
- else `owner` present → `principal = { principalKind: "user", actorId: owner.actorId, actorKind: "human" }`;
  `admit` calls `createRuntimeCloudWorkspace(principal, { ..., orgId: owner.orgId, projectId: task.projectId })`;
  `discard` calls `deleteRuntimeWorkspace(principal, ...)`; `prepare` mints the
  root environment with `{ userId: owner.userId, orgId: owner.orgId, projectId, workspaceId }`
  so the new root's own Tasks grant and owner grant name the same owner.
- neither → the existing "not signed" refusal.

`createHostedTasksComposition` passes `(actor) => identity.principals.capabilityOf(actor)?.owner`
as the third argument of `input.bridge`; `hostedTasksRouteContributions`
threads it. The `origin.actor.scopeId` used for `orgId` today is replaced by
the resolved owner's `orgId` on this path (the same value; the owner is
authoritative).

The reservation that follows (`createTasksSessionReserve` →
`signedTasksRuntimePrincipal` → `capabilityRuntimePrincipal(grant)` →
`reserveRuntimeSession`) already acts as the owner and is unchanged. The new
link row records `startedFrom` from the grant's `scope.sessionId`.

**Nothing the sandbox can call provisions.** After this slice the calls that
end in `sandboxManager.ensure` are reachable only inside
`allocateOriginCloudWorkspace`, on the control plane, after `admit` has
recorded the workspace for a principal the control plane resolved. The
capability routes the sandbox can reach are still exactly `tasksRequestCost`'s
table plus S2's renew route; `/api/workspace/create` remains a signed route the
loopback mount has no fetch for.

### What stays unchanged

- Local starts: `createLocalTasksSessionBridge`
  (`@claxedo/local-server/tasks/session-bridge`) and the unsigned
  local composition; `placement: "local"` on every host.
- Self-hosted signed node: `createSelfHostedTasksComposition`
  (`packages/claxedo-server/src/tasks/self-hosted-composition.ts`) uses the
  local bridge; no cloud allocation there.
- The person's own Start from the app: `auth` path in `createTasksCloudTarget`,
  `createCloudWorkspace(auth, ...)`, no gates.
- `allocateOriginCloudWorkspace`, origin keys, egress allowlist, selected
  capabilities projection, `awaitSandboxReady`.
- `capabilityTasksAuthenticate` and `confineCapabilityBridge`.

### Acceptance criteria

- On staging, with cross-machine on, a preset marked agent-startable, a task
  created by a person (depth 0) and no agent-started roots in the project:
  `task_start` from a hosted session allocates a cloud root owned by the
  workspace's owner (`workspaces.owner_user_id`), reserves and links a
  session, and the task page shows the link; the owner can open it.
- The same call with cross-machine off: the grant has no `start`; the tool is
  not listed and a by-name call is refused before any route is reached.
- Preset not marked: refused with the flag sentence; nothing allocated.
- Depth: a task created by the root started above can be started once more;
  a task created inside that second root is refused with the depth sentence.
- Cap: the fifth concurrent agent-started cloud root in a project is refused;
  archiving one of the four admits the next.
- A capability for project A cannot allocate under project B (`admit` uses
  the owner's project authority for `task.projectId`, which
  `capabilityTasksAuthenticate` already confined to the scope).
- Every refusal is a `TasksFailure` with a sentence; no `StartBlocker`
  vocabulary change.

### Tests

- `packages/claxedo-tasks/src/**`: `agentStartable` in decode/validation/
  model tests; `links.bySession` and the two new link fields in the store
  conformance suite (`conformance/store.ts`) so memory, sqlite and D1 stores
  all prove them (`sqlite-store.test.ts`, `d1-store.test.ts`).
- `packages/claxedo-server-core/src/tasks-host/agent-start-gates.test.ts` (new):
  depth 0/1/2 with a fabricated chain; hop cap; project cap at 3, 4, 5 with
  one archived; flag off/on; signed actors untouched; order of refusals.
- `packages/claxedo-server/src/authority/adapters/d1/workspace-authority.test.ts`:
  `createRuntimeCloudWorkspace` for an active owner who is org admin; refused
  for a suspended actor, a non-admin, a project the owner cannot admin;
  `deleteRuntimeWorkspace` symmetry.
- `packages/claxedo-server/src/tasks/session-bridge-cloud.test.ts`: the
  owner path allocates through the authority as the owner's actor, mints the
  root environment for the owner, records `startedFrom`; the "not signed"
  refusal remains for an actor with neither `auth` nor `owner`.
- `packages/claxedo-server/src/tasks/hosted-composition.test.ts`: the
  composition threads `owner`; capability authentication is tested through
  the real cloud bridge, which the Codex review (finding 6) noted the
  reporting-bridge fixture cannot establish.
- `packages/claxedo-server/src/routes/account-agent-settings.test.ts` (new)
  and `authority/adapters/d1/agent-settings.test.ts` (new); the root
  capability test proves `start` follows the stored row.
- `packages/claxedo-app/src/features/tasks/ui/presets/preset-editor.vitest.tsx`:
  the checkbox writes `agentStartable` into `preset.create`/`preset.edit`.
- `packages/claxedo-server/src/deployments/hosted-shared/app.sandbox-credential-scope.test.ts`:
  no sandbox credential is admitted to `/api/workspace/create` or the
  account-settings routes.
- Live: the staging journey in the acceptance criteria, recorded with the
  D1 `workspaces` row's `owner_user_id` and the link's `startedFrom`.

### Definition of Done — S3

- [ ] Cross-machine setting: migration, reader, routes, Settings row; the root capability minter wired to it. Progress:
- [ ] `agentStartable` through contract, stores, migrations, conformance, editor. Progress:
- [ ] `links.bySession`, `startedFrom`, `placement` on links through all stores. Progress:
- [ ] `gateAgentStarts` decorator with depth, cap and flag; composed for capability actors only. Progress:
- [ ] `createRuntimeCloudWorkspace` / `deleteRuntimeWorkspace` on the authority and the D1 adapter. Progress:
- [ ] Bridge owner path; composition and contribution threading. Progress:
- [ ] Package tests, root typecheck, ratchets, lint green. Progress:
- [ ] Staging journey recorded. Progress:

---

## Execution: parallel lanes

Fable subagents only (`model: "fable"`), each with a disjoint file set; the
orchestrator reads each diff and re-runs its gates before accepting. Names
below are the lane's ownership map; a lane that needs a file outside its map
reports it instead of editing it.

| Lane | Slice | Owns (production files) | Owns (tests) | Depends on |
| --- | --- | --- | --- | --- |
| A | S1 kit | `packages/workspace-runtime/src/owner-grant.ts` (new), `session-access-policy.ts`, `remote-session-authority.ts`, `server.ts`, `routes/session-core.ts` | `owner-grant.test.ts`, `remote-session-authority.test.ts`, `routes/session-children.routes.test.ts`, `routes/session-core.routes.test.ts` | claim names fixed in S1.a |
| B | S1 plane | `packages/claxedo-server/src/session/owner-grant.ts` (new), `routes/runtime-session-authority.ts`, `agent-plugins/runtime/cloud-root-environment.ts`, `hosts/workspace-runtime/runtime-boot.ts`, `hosts/workspace-runtime/first-party-mcp.ts`, `hosts/workspace-runtime/owner-grant.ts` (new env reader), `packages/claxedo-server-core/src/hosts/workspace-runtime/env.ts` | the matching `*.test.ts` | — |
| C | S2 | `packages/claxedo-server/src/tasks/grant-renewal.ts` (new), `hosts/workspace-runtime/tasks-grant.ts`, `deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts`, `deployments/hosted-shared/app.sandbox-credential-scope.test.ts` fixture | `grant-renewal.test.ts`, `tasks-grant.test.ts` | owner-grant re-issue waits for B's minter; `crossMachineWrites` wiring waits for D2 |
| D1 | S3 gates: contract + stores | `packages/claxedo-tasks/src/**` (contracts, decode, validation, presets/model, ports/store, stores/memory, conformance, http/parse), `packages/claxedo-server-core/src/tasks-host/sqlite-store.ts`, `tasks.sql.ts`, `stored-rows.ts`, the local migration, `packages/claxedo-server/src/tasks/d1-store.ts`, `migrations/control-plane/0025_claxedo_tasks.sql` | package tests, `sqlite-store.test.ts`, `d1-store.test.ts` | — |
| D2 | S3 gate 1: setting | `migrations/control-plane/0026_agent_cross_machine_writes.sql` (new), `authority/adapters/d1/agent-settings.ts` (new), `routes/account-agent-settings.ts` (new), the app Settings row, `tasks/root-capability.ts` (reader plumbing only) | matching tests | — |
| D3 | S3 gates 3–5 + editor | `packages/claxedo-server-core/src/tasks-host/agent-start-gates.ts` (new), `tasks-host/contribution.ts` (compose the decorator), `packages/claxedo-app/src/features/tasks/ui/presets/preset-draft-editor.tsx`, `preset-editor-model.ts`, `preset-list.tsx` | `agent-start-gates.test.ts`, `preset-editor.vitest.tsx` | D1 landed |
| E | S3 allocation | `packages/claxedo-server-core/src/platform/auth/authority.ts`, `packages/claxedo-server/src/authority/adapters/d1/workspace-authority.ts`, `tasks/session-bridge.ts`, `tasks/hosted-composition.ts`, `deployments/hosted-workerd/tasks-contributions.ts`, `packages/claxedo-server-core/src/tasks-host/authorization.ts` (only if an `ownerOf` helper is needed) | `workspace-authority.test.ts`, `session-bridge-cloud.test.ts`, `session-bridge.test.ts`, `hosted-composition.test.ts` | D1's `startedFrom` field name (agreed above; E writes it once D1 lands) |

Integration steps owned by the orchestrator after lanes land, each a
handful of lines: C's worker-entry wiring receives D2's reader; C's renewal
re-issues B's owner grant; E sets `startedFrom` on the link once D1's column
exists.

Shared-worktree rules from the project memory apply: no `git stash`, commit
by path (`git commit -- <paths>`), do not run `update-debt-baseline` for
another lane's numbers.

### Verification, per lane and at the end

- Each package's own `scripts.test` (claxedo-server, claxedo-server-core,
  claxedo-mcp and claxedo-app are vitest packages; claxedo-tasks and
  workspace-runtime run `bun test`); read `scripts.test` before running.
- Root `bun turbo typecheck`, root `bun run test:architecture-ratchets`
  (lanes A, B, C, E add or redirect production imports), root oxlint.
- Live: the three staging journeys above, recorded under
  `docs/verification/tasks/` with the D1 rows named in each slice.

---

## Where the code contradicted the brief

1. The 403 `session_actor_required` is produced inside the runtime kit
   (`authorizeManaged` in `packages/workspace-runtime/src/session-access-policy.ts`),
   before any control-plane call. `requireRuntimeActor` is a private method of
   the D1 adapter (`authority/adapters/d1/session-authority.ts`), not part of
   the server-core `private-session-authority.ts` contract.
2. In the merged tree, cloud allocation does not live in
   `tasks/hosted-composition.ts`; that file takes a `bridge` factory. The
   `SignedControlPlaneAuth` requirement is in `tasks/session-bridge.ts`
   (`createTasksCloudTarget`'s `admit`, `discard` and `prepare`).
3. The runtime has no checkpoint push and no `openWorkspace`; checkpoints
   are pulled by the control plane, registration carries the caller's Relay
   Host Token, and the relay tunnel authenticates to the relay. The only
   runtime-originated channel to the control plane is the Tasks grant's fetch,
   which is why S2 renews on it.
4. `crossMachineWrites` has no storage in any deployment
   (`packages/claxedo-server-core/src/platform/auth/cross-machine-writes.ts`),
   so gate 1 has to add the store, not only wire a reader.
5. The Tasks group's activation is the wrong consent for the owner grant;
   subagents are their own tool group, so S1 mints on the subagents group.
6. `hosts/workspace-runtime/**` reaches the control plane only through
   `tasks-grant.ts`; there is no registration or checkpoint code there.
