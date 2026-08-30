# Change Inventory

## Scope

Compared with review base `07599f4026`, takeover-reviewed code head
`4caaf06983` changes 560 files with 37,003 insertions and 4,437 deletions.
The older `430fa0bc1d` / `9bf5849c41` scope below is retained as historical
context; it is not the current branch boundary.

## Files by major area

| Area | Changed files | Primary responsibility |
|------|--------------:|------------------------|
| `packages/claxedo-server` | 87 | Control-plane authority, hosted runtimes, deployment composition, routes, tests |
| `packages/workspace-runtime` | 60 | Session routes/policy, event delivery, PTY/process access, runtime store, terminal subagent replay |
| `convex` | 24 | Tenant schema, migrations, sessions, participants, token revocation |
| `packages/claxedo-server-core` | 20 | Shared auth, Convex/SQLite authority adapters, event visibility |
| `packages/claxedo-app` | 48 | Prompt collision UX, author rendering, central route/hydration authority, snapshot continuity, browser acceptance |
| `packages/agent-sdk-runtime` | 16 | Turn admission lease, runtime attribution, and ACP lifecycle contracts |
| `packages/claxedo-local-server` | 10 | OpenCode compatibility, canonical runtime principals, and local runtime dispatch |
| `.branch_status` | 9 | Review dossier and verification record |
| `packages/workspace-relay` | 6 | Runtime token and relay host proof claims |
| `packages/sandbox-manager` | 4 | Hosted driver configuration |
| `packages/agent-event-runtime` | 4 | OpenCode-compatible event projection |
| `packages/session-ui` | 2 | Canonical task/subagent lifecycle rendering |
| `packages/schema` | 2 | Public/shared schema changes |
| `docs` | 2 | Access model and tenant rollout documentation |
| Repository workflow/root | 4 | Deployment gate and dependency/script wiring |
| `packages/sdk` | 1 | Public display-safe message-author extension type |
| `packages/workspace-relay-protocol` | 1 | Relay protocol identity contract |

## Logical change sets

### 1. Tenant identity foundation

- Adds explicit org/project/workspace identity and canonical project lookup.
- Adds user public identity and actor kind.
- Adds required actor claims to runtime and relay tokens.
- Adds Convex and SQLite migrations and verification contracts.

Key review findings: #2, #6, #16, #18, #24.

### 2. Session privacy and participant authority

- Adds session creator and participant records.
- Adds read/write/register authority operations.
- Filters session collections.
- Adds creator/admin participant management.
- Adds runtime route guards and policy inventory.

Key review findings: #3, #12, #13, #14.

### 3. Prompt admission

- Introduces a per-session lease in `AgentRuntime`.
- Returns structured collision errors.
- Updates app rollback so only the rejected optimistic prompt is removed.

Key review finding: #23.

### 4. Message attribution

- Carries verified actor identity into session/message projection.
- Projects display-safe author identity to clients.
- Renders collaborator author identity in the app.

Key review finding: #28.

### 5. Identity-aware event delivery

- Attaches actor/tenant principals to event subscriptions.
- Adds per-principal retained replay.
- Adds session policy to live and reconnect paths.
- Adds canonical event visibility rules.

Key review findings: #5, #8, #9, #10, #11, #15.

### 6. PTY and process security

- Adds session identity to PTYs.
- Adds read/write policy to PTY routes and sockets.
- Adds periodic authorization refresh.
- Extends workspace role enforcement to process/PTY surfaces.

Key review findings: #12 and #21.

### 7. Revocation and rollout

- Revokes runtime tokens on membership changes.
- Adds tenant migration and access-model documentation.
- Adds policy and two-user focused tests.

Key review finding: #18.

### 8. Runtime-to-UI authority continuity

- Stamps canonical central session placement at the control-plane producer.
- Preserves central/workspace/local identity through inventory, direct routing,
  cache provenance, hydration, and pane query authority.
- Waits for authoritative saved-model restoration before allowing an existing
  session submit.
- Preserves intermediate assistant task parts across snapshot/live merge.
- Retains terminal subagent lifecycle for authorized replay and renders child
  lifecycle independently of a parent task-tool error.
- Tightens the real-harness checks to prove canonical backend completion before
  visible completion.

Post-review acceptance findings: A1-A5 in `review-findings.md`.

## Existing source documents changed by this branch

- `docs/tech-docs/access-model.md`: authoritative product and policy boundary.
- `docs/tech-docs/tenant-identity-schema-rollout.md`: migration order, verification, and rollback.

## Complete path inventory

The exact path list remains reproducible from Git:

```bash
git diff --name-status 07599f40265170bbc426f1b0b7d4701ad7cc060d..4caaf0698356e2310c04d71708f7094071e0b0a0
```

The implementation/test tree is `d95a905f5d6193ca9c8505b1199c9b2f23156dee`.
