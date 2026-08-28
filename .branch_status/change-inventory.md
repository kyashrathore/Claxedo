# Change Inventory

## Scope

Compared with `dev` at `834307041e`, implementation commit `593dd1f94f` changes 265 files with 17,875 insertions and 1,302 deletions.

## Files by major area

| Area | Changed files | Primary responsibility |
|------|--------------:|------------------------|
| `packages/claxedo-server` | 87 | Control-plane authority, hosted runtimes, deployment composition, routes, tests |
| `packages/workspace-runtime` | 58 | Session routes/policy, event delivery, PTY/process access, runtime store |
| `convex` | 24 | Tenant schema, migrations, sessions, participants, token revocation |
| `packages/claxedo-server-core` | 20 | Shared auth, Convex/SQLite authority adapters, event visibility |
| `packages/claxedo-app` | 20 | Prompt collision UX, author rendering, live event preparation, browser acceptance |
| `packages/agent-sdk-runtime` | 15 | Turn admission lease and runtime attribution contracts |
| `packages/claxedo-local-server` | 10 | OpenCode compatibility, canonical runtime principals, and local runtime dispatch |
| `.branch_status` | 9 | Review dossier and verification record |
| `packages/workspace-relay` | 6 | Runtime token and relay host proof claims |
| `packages/sandbox-manager` | 4 | Hosted driver configuration |
| `packages/agent-event-runtime` | 4 | OpenCode-compatible event projection |
| `packages/schema` | 2 | Public/shared schema changes |
| `docs` | 2 | Access model and tenant rollout documentation |
| Repository workflow/root | 3 | Deployment gate and dependency/script wiring |
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
git diff --name-status 834307041e8b01eef532833b8deb3703f03dc647..593dd1f94f047c9269a56b2afea75cce2cb6419e
```

The implementation tree is `6c42070016448f272ce8008fd9b8db98e80c9d21`.
