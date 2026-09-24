# access

Owns: who may do what, answered only from facts the server reports. Every access question in the UI goes through `can()`. "Permission" means an agent request and lives in `src/session/requests/`; this domain never uses the word.

## Concepts

- Principal: `Capabilities.principal` from the adapter (a signed user with an optional org and role, or the machine itself when unsigned).
- Org role: `owner`, `admin` or `member`. Owners and admins manage the org's provider accounts, org plugins and network policy. An org grants nothing on any machine, folder or project.
- Session share: the only grant between people. `follow` reads and streams; `send` also prompts. It ends when revoked. A share never controls the machine.
- Machine ownership: `Capabilities.thisMachine.ownerId`; only the owner runs agents, opens terminals and reads folders on it.

## `can(action, subject?)`

| Action | Answered from |
| --- | --- |
| `session.prompt` | the runtime's `GET /session/:id/capabilities` → `prompt` for that session |
| `session.manageShares` | the control plane's shares list → `canManageShares` |
| `org.manage`, `org.accounts`, `plugins.manage` | the principal's org role is owner or admin |
| `machine.operate` | the principal is the machine, or `thisMachine.ownerId` equals the principal's user id |

Unknown facts answer `false`; nothing is re-derived from relay or runtime rules, and `RolePolicy` is gone.

## Data

Session facts (capabilities, shares) are TanStack queries keyed by `SessionRef`, held for at most 16 sessions and disposed with the provider. Grants and revokes invalidate that session's shares query. `api.ts` is the only file that names today's routes; it moves into `src/server/access.ts` when the adapter exposes `server.queries.access`.

## Machine

`ShareFormState`: `idle` → `confirmingSend(request, acknowledged)` (a `send` grant needs the disclosure acknowledged) or `granting(request)` → `idle`; `revoking(shareId)` → `idle`; any step → `failed(error)` → `idle` on cancel.

## Screens

- `SessionShareControl` (`view/share-control.tsx`): mounted by the session screen; renders nothing until the server reports `canManageShares`.
- Organization settings section (`view/organization.tsx`): the org and your role, members when the server lists them, where org accounts are managed. Other members see the restricted note.

## Flows

36 (org settings open only to owners and admins; follow reads, send prompts, revoke ends both), 23 (team sharing across two browsers).
