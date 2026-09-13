# Tasks from inside a session: MCP tools over a scoped capability

Status: in progress (2026-09-14). Branch `feat/tasks-presets`.

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
  `continue`), each with `access` declarations; `task_start` additionally
  requires the credential's `crossMachineWrites`.
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
