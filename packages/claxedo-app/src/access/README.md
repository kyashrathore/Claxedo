# access

Owns: who may do what, answered only from facts the server reports, and the Organization settings section. "Permission" means an agent request and lives in `src/session/requests/`; this domain never uses the word.

## Concepts

- **Principal** (`Principal` from `@/server`): a user (`userId`, `name`, optional `email`) or a machine (`machineId`). Signed in, on the web and on the desktop alike, it is the user, with the name and email from the auth binding (`useAuth`). Signed out it is the machine from `server.capabilities()`. A role belongs to one organization, so it is read per organization from the membership list (`server.queries.organizations.mine()`, `org.list`) where a screen needs it, never folded into the principal.
- **Org role**: `owner`, `admin` or `member`. Owners and admins manage the org; members manage nothing. An org groups people and grants nothing on any machine, folder or project.

## `useAccess()` (`store.ts`)

Returns `principal`, `can(action, facts?)` and `session(ref)`. It holds no state of its own: it reads the auth state and `server.capabilities()`, and accepts the facts the account queries report, so it needs no provider.

| Action (`AccessAction`, `model.ts`) | Answered from |
| --- | --- |
| `accounts.removeOrg` | `canRemoveOrgAccounts` from the credential server's account-source response; missing facts deny access |
| `sandbox.manage` | `canManageSandboxKeys` from the credential server's sandbox-key listing (an org owner or admin on a hosted plane, the operator at the machine locally); missing facts deny access |

A fact the server has not reported answers `false`. Nothing is re-derived from relay, runtime or control-plane rules. `scripts/checks/access-boundary.ts` enforces this outside `src/access`: it fails a comparison, `switch` case or list membership on a role name, an ordering on a rank, and a read of `capabilities.prompt` or of a share-management flag.

## Screens

- **Organization** settings section (`organizationSettingsSection`, `/settings/organization`), drawn by `view/organization.tsx`:
  - signed out: the sign-in button when the auth binding offers sign-in (a failed sign-in shows a toast), "Checking account…" while signing in, otherwise a note to sign in;
  - signed in: each organization the person belongs to and its members (`server.queries.organizations.members(orgId)`, `org.members.list`): each member's name from the auth store (or "Member without a name"), "You" on the person's own row, and their role; owners and admins read that they manage the members and the provider accounts, members that only owners and admins manage the organization;
  - no organization: a note that they are not in one;
  - each read shows "Loading…" after the placeholder delay and a failure with Retry.

There is no invite, role change or org switcher here yet.

## Flows

Flow 15 (`e2e/flows/15-settings.spec.ts`) opens the Organization section among the settings sections (`15-settings.navigation.ts`). `15-settings-remove-account.spec.ts` covers local-operator removal of a saved organization credential while preserving the machine login. `53-settings-web.spec.ts` covers a signed-in browser seeing its organization, role and members.

## Shared sessions

`session(ref)` answers from the signed account's shared-session row (`sessionControls`, `model.ts`): a session without one is the reader's own, with every control; a `send` share drives the agent and answers its requests on the owner's accounts; a `follow` share only reads, and cannot stop a background task either. Neither owns the session, so the session screen offers no fork, goal, model, permission mode or turn recovery and writes no attachment into the owner's workspace; the rail lists shared sessions in their own section with no session menu. A follow share gets the read-only composer, whose Send is blocked with the `session-share` reason. A row that disappears while its session is open makes the screen say "This session is no longer shared with you."

`e2e/flows/47-shared-sessions.spec.ts` covers two signed people: in the browser a follow share is listed and opened, follows a live owner turn, is upgraded to send and sends, and is revoked to an unavailable screen; a send share's turn on a cloud sandbox spends the owner's OpenAI key, not the sender's; and on a signed desktop the share is listed, opened and sent to through main's account.
