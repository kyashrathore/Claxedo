# access

Owns: who may do what, answered only from facts the server reports, and the Organization settings section. "Permission" means an agent request and lives in `src/session/requests/`; this domain never uses the word.

## Concepts

- **Principal**: `Capabilities.principal` from `@/server`: a user (`userId`, `name`, optional `orgId` and `orgRole`) or a machine (`machineId`). The adapter (`src/server/capabilities.ts`) reports only the machine principal, so org-role actions answer `false` and the Organization section shows its signed-out branch until the server reports a user. Account removal uses the credential server's separately reported operator fact.
- **Org role**: `owner`, `admin` or `member`. Owners and admins manage the org; members manage nothing. An org groups people and grants nothing on any machine, folder or project.

## `useAccess()` (`store.ts`)

Returns `principal`, `orgRole` (the user principal's role, `undefined` for a machine) , `can(action, facts?)` and `session(ref)`. It holds no state of its own: it reads `server.capabilities()` and accepts account-source facts from the account query, so it needs no provider.

| Action (`AccessAction`, `model.ts`) | Answered from |
| --- | --- |
| `org.manage`, `org.accounts`, `plugins.manage` | the principal's org role is `owner` or `admin` (`isOrgManager`) |
| `accounts.removeOrg` | `canRemoveOrgAccounts` from the credential server's account-source response; missing facts deny access |

A fact the server has not reported answers `false`. Nothing is re-derived from relay, runtime or control-plane rules. `scripts/checks/access-boundary.ts` enforces this outside `src/access`: it fails a comparison, `switch` case or list membership on a role name, an ordering on a rank, and a read of `capabilities.prompt` or of a share-management flag.

## Screens

- **Organization** settings section (`organizationSettingsSection`, `/settings/organization`), drawn by `view/organization.tsx`:
  - signed out: the sign-in button when the auth binding offers sign-in (a failed sign-in shows a toast), "Checking account…" while signing in, otherwise a note to sign in;
  - a user with no org: a note that they are not in one;
  - a user in an org: their name, "You" and their role; owners and admins also see where the org's provider accounts are managed, members see that only owners and admins manage the org.

There is no member list, team screen or org switcher: `src/server/` has no route that lists members.

## Flows

Flow 15 (`e2e/flows/15-settings.spec.ts`) opens the Organization section among the settings sections (`15-settings.navigation.ts`). `15-settings-remove-account.spec.ts` covers local-operator removal of a saved organization credential while preserving the machine login. No flow covers a signed-in user's org role.

## Shared sessions

`session(ref)` reads the owned placement catalog and the signed account's shared-session row for the exact workspace and session. `sessionControls` (`model.ts`) answers `available`, `send`, `manage` and `shared`. Owned sessions allow sending and management; a `follow` share permits reading, a `send` share permits agent turns, and neither permits session management. Missing facts deny access. The session screen renders a read-only follow composer without editable composer hooks or Send. Shared rows have no rename, archive, delete or share menu, and shared composers offer no fork, shell, goal, model configuration or permission-mode writes. Send holders can send prompts and answer agent requests using the owner's session and credentials. Revocation removes the canonical row on the next read and renders Session unavailable in the open screen.

`e2e/flows/47-shared-sessions.spec.ts` covers two signed browser users: share follow, discover/open, observe a live owner turn, upgrade to send, send and read the reply as owner, revoke, remove the row and make the open screen unavailable. Run `bun run e2e --project=web e2e/flows/47-shared-sessions.spec.ts` after the verifier builds the app. Signed Electron main credential routing and owner-account spending require the verifier's desktop/cloud acceptance checks.
