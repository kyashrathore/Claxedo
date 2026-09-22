**Not merge-ready.** The capability’s signature and owner checks are sound, but downstream authorization widens its effective scope. S4 also has deployment gaps: the shared node/hosted mount ignores group gating, ordinary cloud workspaces receive no group configuration, and a project-specific Marketplace switch changes every listed project. Reviewed range: `4548e852f1..87a486d742`—35 commits, 119 files. `HEAD` advanced and other edits appeared during review; those are excluded from the findings. No source changes were made.

## Findings

### P1 — A capability can direct Start into another project’s workspace

**Location:** [capability.ts:69](packages/claxedo-server-core/src/tasks-host/capability.ts:69), [authorization.ts:187](packages/claxedo-server-core/src/tasks-host/authorization.ts:187)

The capability checks the task’s `projectId`, but accepts its independently supplied `workspaceId`. Start subsequently resolves that workspace directly in `session-bridge-core.ts:409`. Reservation checks the owner’s workspace access, without preserving the capability’s project restriction.

**Reproduction:** With a capability for project A, POST `task.create` with `projectId: "project-a"` and `workspaceId: "ws-other-project"`. The real Tasks routes returned **200** and persisted that workspace. With `start` granted, a local-placement preset can then target another project’s workspace accessible to the owner.

**Fix:** Validate the destination workspace against the capability’s project and the owner’s authority before preview, runtime reads, and reservation. Recheck persisted workspace preferences during Start.

### P1 — Capability callers bypass private-session authorization

**Location:** [authorization.ts:203](packages/claxedo-server-core/src/tasks-host/authorization.ts:203)

For capability actors, `authorizeSessionOpen` returns true whenever `workspaceId` is non-null. Project membership does not establish access to every private session linked to a shared task.

**Reproduction:** A task in project A has a previous session belonging to another participant. A capability actor can see its link and pass the transcript gate during Start/Continue. `session-bridge-core.ts:356` trusts this authorization result before reading messages and configuration. A direct probe returned **true** for a foreign session despite an authority implementation that refuses session reads.

**Fix:** Resolve session access through the canonical session authority as the workspace owner. Preserve both project confinement and private-session authorization.

### P1 — The node/hosted MCP contribution drops `enabledToolGroups`

**Location:** [first-party-mcp.ts:93](packages/claxedo-server/src/mcp/first-party-mcp.ts:93)

`FirstPartyMcpOptions.enabledToolGroups` is accepted upstream but never passed to `createClaxedoMcpRoutes`.

**Reproduction:** Construct the node contribution with `enabledToolGroups: () => []`. An in-process MCP client still listed and successfully called a registered tool. Disabling a group while leaving another enabled therefore fails to restrict self-hosted sessions.

**Hosted OAuth/CLI result:** **These callers are not gated the same way.** `core-worker.cf.ts:115` supplies all registrations without an activation resolver, and the shared contribution would discard a resolver anyway. Existing audience/OAuth-scope checks still apply; Tasks remains absent without a Tasks client.

**Fix:** Forward the resolver and wire an explicit activation policy for both node runtime callers and hosted user callers. Add contribution-level disabled-group tests; testing only the lower-level mount misses this seam.

### P1 — Ordinary cloud workspaces lose the first-party tools

**Location:** [runtime-boot.ts:147](packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts:147)

An absent `WORKSPACE_RUNTIME_MCP_TOOL_GROUPS` becomes `[]`. Its only production producer is `createTasksRootCapability`, reached through task-created cloud roots. Ordinary cloud provisioning passes project environment without resolving built-in activation.

**Reproduction:** Enable Tasks—or retain the default Sessions group—then create an ordinary cloud workspace through the workspace route. Its boot environment lacks the group declaration, so new sessions receive no first-party MCP entry.

**Fix:** Put group preparation in the canonical cloud-workspace provisioning path, including ordinary creation and reprovisioning. Mint Tasks capability there only when enabled. Keep task-specific selected-capability preparation separate.

### P1 — A project-specific switch grants Tasks across all listed projects

**Location:** [directory.tsx:157](packages/claxedo-app/src/features/agent-plugins/directory/directory.tsx:157), [directory.tsx:263](packages/claxedo-app/src/features/agent-plugins/directory/directory.tsx:263)

The catalog read uses the selected project, but `activationTarget` writes every project in `catalog.projects`. The server returns that complete project list even for project-specific catalog reads.

**Reproduction:** An account has projects A and B. Select A and enable Tasks. The request targets `[A, B]`, granting future roots in B a capability too. Existing UI tests use one project and assert the outgoing request, masking the scope error.

**Fix:** Target the selected project when one is selected. Use the explicit cross-project scope only from the cross-project view. Test persisted activation in two projects.

### P2 — A granted hosted cloud Start still lacks the identity required downstream

**Location:** [hosted-composition.ts:109](packages/claxedo-server/src/tasks/hosted-composition.ts:109), [session-bridge.ts:153](packages/claxedo-server/src/tasks/session-bridge.ts:153)

Capability actors live in the grant registry, so `principals.authOf(actor)` returns undefined. Cloud allocation nevertheless requires that signed auth and refuses the request.

**Reproduction:** Present a valid capability containing `read` and `start`, then start a task using an owned cloud preset. Allocation refuses with “this caller is not signed.”

Additionally, the production composition supplies no `crossMachineWrites` reader, so hosted capabilities never receive `start`. This limitation is acknowledged in the verification document but contradicts the plan’s blanket completion status.

**Fix:** Carry the owner-derived authority through cloud allocation without fabricating a signed principal. Wire the account-setting reader. Test capability authentication through the real cloud bridge; the reporting bridge and always-signed bridge fixture cannot establish this flow.

### P2 — Hosted Tasks stops working after the boot token expires

**Location:** [tasks-grant.ts:40](packages/claxedo-server/src/hosts/workspace-runtime/tasks-grant.ts:40), [capability.ts:17](packages/claxedo-server/src/tasks/capability.ts:17)

The capability defaults to 30 minutes. The runtime captures its token at boot, with no renewal or replacement path.

**Reproduction:** Leave a cloud root running for over 30 minutes, then call `task_list`. The expired token is correctly rejected, but even a fresh session in that runtime uses the same expired credential.

**Fix:** Implement control-plane-authorized renewal and runtime replacement, rechecking ownership and activation. Keep the expiry check.

### P2 — Capability callers can forge task provenance

**Location:** [authorization.ts:150](packages/claxedo-server-core/src/tasks-host/authorization.ts:150), [tasks/service.ts:326](packages/claxedo-tasks/src/tasks/service.ts:326)

The MCP handler constructs provenance correctly, but a sandbox can call the control-plane route directly. Admission never compares `createdFrom` with the verified capability.

**Reproduction:** A capability naming `ws-a/ses-a` submits `createdFrom: { workspaceId: "ws-victim", sessionId: "ses-victim" }`. The real routes returned **200**, persisting the forged reference that the task page renders.

**Fix:** Enforce provenance at capability admission using authoritative session identity. Reject conflicting references; for workspace-scoped grants, validate the session against that workspace’s authority.

### P2 — Preset-name resolution searches only the first page

**Location:** [tasks.ts:246](packages/claxedo-mcp/src/tools/tasks.ts:246)

`presetFor` ignores `nextCursor` when resolving a name.

**Reproduction:** The requested preset exists on page two. `task_start` reports “No preset is named …” after inspecting only page one.

**Fix:** Follow the canonical cursor until a match or exhaustion. Test a match on a later page.

### P2 — The sandbox invariant guard can pass with credential admission broken

**Location:** [app.sandbox-credential-scope.test.ts:174](packages/claxedo-server/src/deployments/hosted-shared/app.sandbox-credential-scope.test.ts:174), [app.sandbox-credential-scope.test.ts:445](packages/claxedo-server/src/deployments/hosted-shared/app.sandbox-credential-scope.test.ts:445)

The guard uses `testRequestAuthenticationAdapter`, which authenticates **any bearer** as a user. Its assertions detect differing successful responses to foreign names, rather than enforcing the intended credential-to-route admission matrix. Constant successful responses escape detection; 5xx routes are collected as unprobed without failing.

The generic request also places `workspaceId: null` inside `task.create`, so it never exercises finding 1.

**Reproduction:** Admit a runtime bearer to a route returning a constant success response. Foreign, nonexistent, and unnamed probes match, producing no finding.

**Fix:** Use production verification or a strict accepted-token fixture, assert explicit route admission, fail unexpected unprobed routes, and exercise valid request bodies with independently varied nested scope fields.

### P3 — Comments contradict implementation and defend duplicated contracts

**Location:** [tasks.ts:36](packages/claxedo-mcp/src/tools/tasks.ts:36), [session-grants.ts:30](packages/claxedo-server/src/tasks/session-grants.ts:30), [start.ts:27](packages/claxedo-tasks/src/start.ts:27)

Concrete examples:

- `tasks.ts` justifies duplicated enums by avoiding the kit root, while already importing `admissibleAttempt` from that root.
- `session-grants.ts` claims ended sessions retain no access, but `revoke` has no production caller; issued handles accumulate.
- The origin-key documentation is attached above `admissibleAttempt`, which returns a number.

**Fix:** Reuse canonical enum exports, connect grant cleanup to lifecycle ownership, and remove or relocate comments so they describe actual constraints.

## Checked and found sound

- **Cryptography:** EdDSA verification constrains algorithm, issuer, audience and subject. Direct probes accepted a valid token and rejected payload tampering and expiry.
- **Owner identity:** Capability admission resolves the workspace owner and compares user, organization and project. It does not adopt the token’s user claim as the actor.
- **Credential separation:** The runtime Tasks fetch stamps the control-plane capability over caller-supplied authorization. I found no new forwarding path that sends the runtime’s HS256 bearer as a control-plane credential.
- **Operation gates:** Missing Tasks operations prevent registration, and registered handlers recheck access. Calling by name does not bypass these checks.
- **Group gates where wired:** The direct loopback mount filters registrations and incorporates the enabled set into its MCP session key.
- **Minting OFF:** The root minter returns group environment without a Tasks token when Tasks is disabled.
- **Mutation guards:** Whole-plugin `claxedo` writes and well-formed unknown `claxedo:<group>` writes are refused by the reviewed routes.
- **Provenance transport/storage:** Contract, decoding, stores and task-page consumer carry `createdFrom`; its missing authorization is finding 8.
- **Subagents:** The `none` instruction-channel branch omits create-time instructions and prefixes the first prompt.
- **Shared attempt calculation:** App, MCP and service use `admissibleAttempt`.

## Commands and outcomes

Scope inspection:

```sh
git log --oneline 4548e852f1..HEAD
git diff 4548e852f1..HEAD
git diff --stat 4548e852f1..HEAD
git diff --name-only 4548e852f1..HEAD
git status --short
git rev-parse HEAD
git log --oneline -5
git diff 87a486d742..HEAD --stat
git -c core.fsmonitor=false status --short
```

Outcome: original tip `87a486d742`, 35 commits/119 files; concurrent commit `cf009bf24f` and later dirty edits detected. Further inspection used pinned `git show 87a486d742:<path>` and path-scoped diffs, plus `cat`, `sed`, `nl` and `rg` to trace callers and contracts.

From `packages/claxedo-tasks`:

```sh
bun test
```

**204 passed, 0 failed.**

From `packages/claxedo-mcp`:

```sh
node ./node_modules/vitest/vitest.mjs run src/tools/tasks.test.ts src/tools/subagents.test.ts src/tools/inventory.test.ts src/server.test.ts
```

**Blocked before tests:** EPERM creating Vitest temporary/cache files.

From `packages/claxedo-server`:

```sh
node ./node_modules/vitest/vitest.mjs run src/tasks/capability.test.ts src/tasks/root-capability.test.ts src/tasks/hosted-composition.test.ts src/hosts/workspace-runtime/tasks-grant.test.ts src/hosts/workspace-runtime/first-party-mcp.test.ts src/mcp/self-hosted-tasks-mcp.test.ts src/agent-plugins/routes.test.ts src/deployments/hosted-shared/app.sandbox-credential-scope.test.ts
```

**Blocked before tests:** EPERM writing bundled Vitest configuration.

From `packages/claxedo-server-core`:

```sh
node ./node_modules/vitest/vitest.mjs run src/tasks-host src/agent-plugins/builtin/plugin.test.ts
```

**Blocked before tests:** EPERM creating Vitest temporary/cache files.

From `packages/claxedo-local-server`:

```sh
node ./node_modules/vitest/vitest.mjs run src/agent-plugins/activation/routes.test.ts src/app/first-party-mcp.live.test.ts src/app/first-party-mcp-subagents.live.test.ts
```

**Blocked before tests:** EPERM writing bundled Vitest configuration.

From `packages/claxedo-app`:

```sh
bun run test:vitest -- src/features/agent-plugins/directory/directory.ui.vitest.tsx src/features/tasks/ui/detail/task-detail.vitest.tsx
bun test --conditions=browser --preload ./happydom.ts src/features/agent-plugins/api.test.ts src/features/tasks/view-model.test.ts
```

First command: **blocked before tests**, EPERM writing bundled configuration. Second: **26 passed, 0 failed**, against the working tree including the concurrent API change; this is not pristine-range verification.

Three additional read-only `bun --eval` probes exercised the production MCP contribution, Tasks routes/authorization, and capability signing/verifying. Their observed outcomes are recorded in findings 1–3 and 8 and under cryptography above. No cloud acceptance run, typecheck, build or architecture-ratchet run was completed.

