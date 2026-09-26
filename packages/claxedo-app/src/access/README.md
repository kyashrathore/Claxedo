# access

Owns: who may do what, answered only from facts the server reports. Every access question in the UI goes through `useAccess().can()`. "Permission" means an agent request and lives in `src/session/requests/`; this domain never uses the word.

## Concepts

- **Principal**: `Capabilities.principal` from the adapter: a signed user with an optional org and org role, or the machine itself when unsigned.
- **Org role**: `owner`, `admin` or `member`. Owners and admins manage the org's provider accounts, org plugins and network policy; members manage nothing. An org groups people and grants nothing on any machine, folder or project.
- **Session share**: the only grant between people. `follow` reads and streams; `send` also prompts. It ends when revoked, and never controls the machine.

## `can(action)`

| Action | Answered from |
| --- | --- |
| `org.manage`, `org.accounts`, `plugins.manage` | the principal's org role is `owner` or `admin` |

A fact the server has not reported answers `false`. Nothing is re-derived from relay, runtime or control-plane rules. `useAccess()` holds no state of its own: it reads `server.capabilities()`, so it needs no provider.

## Screens

- **Organization** settings section (`/settings/organization`): the org and your role. Owners and admins see where the org's provider accounts are managed; members see that only owners and admins manage the org. There is no member list, because today's server has no route that lists members, and no team screens or org switcher.

## Flows

36 (org settings open only to owners and admins; follow reads, send prompts, revoke ends both) and 23 (team sharing across two browsers) run on the signed stack.
