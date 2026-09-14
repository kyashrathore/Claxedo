# Tasks from inside a session: MCP tools over a scoped capability

Status: S1–S4 built and proven live on the local stack (2026-09-14). Branch `feat/tasks-presets`. The first-party server is a built-in Marketplace plugin enabled per tool group; the Tasks capability is minted only when the Tasks group is enabled.

## Goal

An agent in any Claxedo session can create tasks, read them, and start a task's
session, through the first-party MCP it already has, with the same posture the
product gives every other integration: a control-plane-issued grant scoped to
the session's workspace and project, revocable, audited, resolved to the actor
by the control plane's own records rather than by anything the runtime asserts.

## Decisions

- The tools live in the existing loopback first-party MCP (`@claxedo/mcp`),
  next to the runtime tools. Account tools forward to the control plane; runtime
  tools stay in-process. One endpoint for the agent.
- The forwarded credential is a **Tasks capability** the control plane mints,
  signed with the same key as the Agent Plugins gateway token
  (`CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM`), scope
  `{ userId, orgId, projectId, workspaceId, sessionId?, operations }`. The
  runtime credential (HS256, self-issued by the runtime) never reaches the
  control plane.
- Operations: `read` (list, get) and `create` are granted to every root the
  capability is minted for; `start` is granted only when the account setting
  that lets agents act on other machines is on — the same rule that gates
  creating a cloud workspace from inside a session (`crossMachineWrites`).
- A session may act only in the project of its own workspace in this version.
- Every task a session creates records the session (`createdFrom`), shown on
  the task page.
- Locally the local server is both runtime host and control plane: the loopback
  mount hands the tools an in-process fetch and the single local actor; no
  capability is minted; the tool code is identical.
- Not in this plan: attaching the calling session to a task as its link, a
  default preset, candidate configurations per slot.

## Request flow (hosted)

1. Root preparation mints the capability beside the gateway tokens and hands
   it to the cloud runtime host with the rest of its prepared credentials.
2. The runtime host's loopback MCP mount builds its client with
   `tasks: { fetch, operations }`, where `fetch` carries the capability as the
   bearer to the control plane's Tasks routes.
3. `task_create` → `assertToolAccess` (audience, read-only, operation in scope)
   → `task.create` command over that fetch → Tasks `authenticate` capability
   branch verifies signature, expiry and scope, resolves the actor from the
   workspace's owner, refuses a project outside the scope → `TasksService`
   as from the app → response → `mcpAuditRecord` with the calling session.
4. `task_start` → the existing preview-then-start pair; the bridge creates and
   links the session; the tool returns the session reference.
5. `tools/list` advertises only the operations the scope grants.
6. A control plane the sandbox cannot reach is answered with a sentence, the
   way the documents tools answer a deployment without `/documents`.

## Slices and definition of done

### S1 — capability and the Tasks authentication branch (server side)

Owner: `packages/claxedo-server/**`, `packages/claxedo-server-core/**`,
`packages/claxedo-local-server/**`.

- `TasksCapabilityScope` and `mintTasksCapability` / `verifyTasksCapability`
  beside `agent-plugins/mcp/runtime-token.ts`, same key, TTL capped like the
  gateway token, `operations: ("read" | "create" | "start")[]`.
- Root preparation mints it for every cloud root and hands it to the runtime
  host; the runtime host's loopback mount (`hosts/workspace-runtime/first-party-mcp.ts`)
  supplies `tasks: { fetch, operations }` to the MCP client, the fetch
  presenting the capability to the control plane's Tasks routes over the same
  channel the runtime already uses to reach the control plane.
- `signedTasksIdentity` gains a capability branch: verify, resolve the actor
  from the workspace's owner through the authority, refuse when the project in
  the request is not the scope's, refuse an operation the scope lacks.
- Local: `local-app.ts` supplies `tasks: { fetch: localFetch, operations: all }`.
- Tests: mint/verify round trip and expiry; a forged or re-scoped token
  refused; a request for another project refused; the actor resolved from
  ownership, never from the token's `userId` alone; local mount wiring.

### S2 — the tool group

Owner: `packages/claxedo-mcp/**`.

- `McpClientInputs.tasks?: { fetch: ClaxedoFetch; operations: readonly TasksOperation[] }`,
  a `tasks` client on `ClaxedoMcpClient`.
- Tools `task_create` (title, description, `backlog | todo`, optional parent;
  project defaults to the session's own), `task_list` (status filter),
  `task_get`, `task_start` (task, optional preset id, optional slot,
  `continue`), each with `access` declarations. The grant is the only gate:
  whoever minted it applied the account's cross-machine setting when deciding
  whether `start` is in it, so the tool asks no second question.
- `tools/list` omits tools whose operation the scope lacks; the handler-side
  check refuses regardless.
- Refusal sentences for: no Tasks client (deployment without Tasks), control
  plane unreachable, operation not granted, task or preset not found, preview
  blockers (the blocker's detail verbatim).
- Tests through the real registry against a fake fetch: every tool, every
  refusal, `tools/list` filtering, audit record carrying `callerSessionId`.

### S3 — provenance

Owner: `packages/claxedo-tasks/**` and `packages/claxedo-app/src/features/tasks/**`.

- `Task.createdFrom: SessionReference | null` in the contract, decoder, all
  three stores (nullable columns in the unreleased migrations, edited in
  place), `task.create` input `createdFrom?` validated, conformance case.
- The task page shows "Created from session" as a link when set.

### Verification

Each slice: its package gates (tests, typecheck), root ratchets and lint. Live:
on the local stack, a session's agent creates a task through `task_create`
and it appears in the Tasks list with the provenance line; `task_start` from
that session starts a session linked to the task. Hosted capability minting
and verification are proven by tests against the real signing path; a real
cloud root is gated on sandbox credentials as before.

## S4 — the first-party server as a Marketplace plugin (2026-09-14)

Decision (user): the Claxedo MCP server is no longer injected into every
session by the runtime. It is a built-in plugin in the Marketplace that the
user enables per tool group, activated per project like every other plugin,
and its Tasks capability is minted only when the Tasks group is enabled, so
consent and credential are one act.

Defaults (user-approved 2026-09-14): one switch per tool group (attention,
documents, processes, review, sessions, subagents, tasks, workspaces); a new
project starts with every group on except Tasks, and Documents on where the
documents service runs in the same process (local) and off where it is an
account service (hosted).

- Catalog: a first-party entry `claxedo` that is always present, not sourced,
  not removable, whose servers are the tool groups with their tool names.
  Whether one plugin carries six selectable servers or the family is six
  first-party plugins depends on what the activation model can select today;
  the lane reads it and picks the shape that needs no parallel activation path.
- Activation defaults per deployment as above; the activation read exposes,
  for the built-in, each group's enabled state and tool names.
- Runtime: `firstPartyMcpAdapterConfig` includes the server entry only when
  the plugin is active with at least one group; the MCP mount takes the
  enabled group set, registers only those groups, and refuses a tool outside
  them even when asked by name; `tools/list` shows exactly the enabled groups.
- Tasks: the capability minter for a cloud root mints only when the Tasks
  group is enabled for the root; the self-hosted node supplies the grant only
  when it is enabled.
- Marketplace: the directory renders the built-in like any other row, with
  per-group switches and the tool list under each group; nothing to install.
- Tests: activation defaults per deployment; a session launched with the
  plugin off carries no first-party MCP entry; a mount with a subset of groups
  lists and admits exactly those tools; the Tasks capability is absent when
  the group is off; the directory row's switches write activation.
- Live: on the local stack, turn Tasks off in the Marketplace and a fresh
  session's tool list has no `task_*`; turn it on and it does.

## Decisions taken at merge (2026-09-14)

- **Hosted user-credential MCP mount stays ungated by activation.** A signed
  CLI or OAuth client is the account holder's own client, not a sandbox: it
  carries no project, so the per-project switches cannot apply to it, and the
  hosted worker mints no Tasks grant for it, so the Tasks tools are absent
  there regardless. The Marketplace switches govern sessions. Gating these
  callers by the user's all-projects activation is follow-up F4 below.
- **The built-in card's whole-plugin action is "Restore defaults" and posts
  a return-to-defaults, never an enable.** An enable on the whole built-in
  would turn the Tasks group on, and turning that group on mints a
  capability that leaves the project; that consent belongs to the Tasks
  switch alone.
- **Onboarding v1 repair is parked behind this merge.** Its plan
  (`2026-09-14-002-feat-onboarding-v1-repair.md`) touches the app shell and
  route files another session is editing; it starts on its own branch once
  `dev` carries this merge.

## Follow-ups (recorded, not built)

F1 — **Hosted cloud Start from inside a session.** A capability actor has no
signed principal (`principals.authOf(actor)` is undefined), and cloud
allocation in `tasks/hosted-composition.ts` and `tasks/session-bridge.ts`
requires one, so `task_start` on a cloud preset from a hosted session is
refused with "this caller is not signed". Minimal design: carry the grant's
resolved owner (`TasksCapabilityOwner`: userId, actorId, orgId, projectId)
into the bridge and add an authority operation that creates and deletes a
cloud workspace for a canonical owner principal, the way
`reserveRuntimeSession` already takes a runtime principal. No fabricated
signed principal. Also wire an account `crossMachineWrites` reader into the
capability minter; today the production composition supplies none, so hosted
grants never carry `start`.

F2 — **Capability renewal.** `tasks/capability.ts` mints with a 30-minute
TTL and `hosts/workspace-runtime/tasks-grant.ts` captures the token at boot.
A cloud root older than 30 minutes loses the Tasks tools for every session,
including new ones. Design: the runtime asks the control plane for a fresh
capability through the same channel it reports checkpoints on; the control
plane re-resolves the workspace owner and the Tasks group's activation before
re-minting; the runtime swaps the grant's bearer in place. Keep the expiry
check as is.

F3 — **Hosted `create_subagent`.** Refused today with 403
`session_actor_required` before the reservation gate, because the runtime's
issuer is built without a user identity. Needs the authority contract change
across the runtime issuer, the session reservation and the private-session
authority. The two-line version that stamps any actor is a privilege bypass
and must not be taken.

F4 — **Gate hosted user-credential MCP callers by activation.** Resolve the
user's all-projects world (`runtimeSnapshotForUser`) for signed CLI callers,
add an OAuth-claims-to-auth mapping for OAuth callers, and hand the mount an
`enabledToolGroups` resolver for both.

F5 — **Self-hosted Tasks handles accumulate per MCP session.** `revoke` had
no caller and was removed; a handle now lives until the process ends and is
bounded by the request-time owner read. If lifetimes matter, the hook point is
`createMachineSessionDispatch` in `deployments/self-hosted-node/app.ts`, where
a session's end is observable.

F6 — **Cursor spelling of first-party tool names is not pinned.** The
transcript resolver covers Claude (`mcp__claxedo__<tool>`), Codex (bare tool
with `input.server`) and the embedded engine (`claxedo_<tool>`); Cursor emits
`mcp*` names and is covered by whichever of the first two shapes it uses, but
no fixture asserts it.

F7 — **Dev-side reds this branch does not own.** The isolated
`verify:closure` step for the self-hosted server cannot find
`@claxedo/egress-broker`'s dist (dev's own build order); claxedo-mcp
`sessions.test.ts` has three `session_create` cap cases red; claxedo-server
`deployment-closures`, `local-product-contract`, `codebase-shape` and the Pi
document round-trip are red on dev alone.
