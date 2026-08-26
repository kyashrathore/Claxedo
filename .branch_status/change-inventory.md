# Change Inventory

## Scope

Compared with `codex/claxedo-platform-release-hardening` at `866feaabe2`, the implementation commit changes 209 files with 12,392 insertions and 891 deletions.

## Files by major area

| Area | Changed files | Primary responsibility |
|------|--------------:|------------------------|
| `packages/claxedo-server` | 69 | Control-plane authority, hosted runtimes, deployment composition, routes, tests |
| `packages/workspace-runtime` | 55 | Session routes/policy, event delivery, PTY/process access, runtime store |
| `packages/claxedo-server-core` | 16 | Shared auth, Convex/SQLite authority adapters, event visibility |
| `packages/claxedo-app` | 16 | Prompt collision UX, author rendering, live event preparation |
| `packages/agent-sdk-runtime` | 14 | Turn admission lease and runtime attribution contracts |
| `convex` | 14 | Tenant schema, migrations, sessions, participants, token revocation |
| `packages/workspace-relay` | 6 | Runtime token and relay host proof claims |
| `packages/claxedo-local-server` | 6 | OpenCode compatibility and local runtime dispatch |
| `packages/sandbox-manager` | 4 | Hosted driver configuration |
| `packages/agent-event-runtime` | 4 | OpenCode-compatible event projection |
| `packages/schema` | 2 | Public/shared schema changes |
| `docs` | 2 | Access model and tenant rollout documentation |
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

## Existing source documents changed by this branch

- `docs/tech-docs/access-model.md`: authoritative product and policy boundary.
- `docs/tech-docs/tenant-identity-schema-rollout.md`: migration order, verification, and rollback.

## Complete path inventory

The exact path list remains reproducible from Git:

```bash
git diff --name-status 866feaabe2fa1f80f51aa05d7788626ae7a3bf5b..c97d1fe3cefed0f6aeb9da1e0f38bc6b4b308924
```

The implementation tree is `062fc24c33c72d10fab3cede8f9267e97a66174b`, which is the same tree independently reviewed before the final rebase.
