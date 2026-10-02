# Access model

People reach code through three things: an organization, the teams inside it,
and the grants that name a project. Everything below is what the hosted
control plane (D1) enforces today.

## Glossary

- **Organization (org)**: the tenant. It owns projects, holds shared
  configuration (provider credentials, Agent Plugins defaults), and is the boundary
  every grant stays inside. Every user has a personal org created with their
  account; a collaborative org is created explicitly and its creator is its
  **founding owner** (`orgs.owner_user_id`).
- **Org member**: a person with an active `org_memberships` row. Org roles are
  `member`, `admin` and `owner`.
- **Team**: an access group inside one org (`teams.org_id`). Its members
  (`team_memberships`, roles `member`, `admin`, `owner`) must be members of
  that org. A team owns nothing; it receives project grants.
- **Project**: one repository inside one org, with an opaque `project_id` and
  its creator as owner (`projects.owner_user_id`). `(org_id, repo_key)`
  identifies the repository inside the org, so the same repository opened by
  two orgs is two isolated projects.
- **Workspace**: a checkout and execution location of a project. Its
  `org_id` and `project_id` never change.
- **Project access**: a person's role on a project, `viewer`, `editor`,
  `admin` or `owner`, the highest of:
  - **owner**: they own the project (`owner`);
  - **member grant**: their own `project_memberships` row (`viewer`,
    `editor`, `admin`);
  - **team grant**: the best `team_project_grants` row of a team they are on
    in the project's org;
  - **org role**: org owners and admins are `admin`, org members `viewer`.

  Nobody outside the project's org has any role on it, whatever rows name
  them. Project access governs the project (its access listing, its grants)
  and never a workspace, a session or a machine; see the resource hierarchy
  below.

## One authorization owner

Every access question the hosted control plane asks is
`may(database, principal, action, resource)` in
`packages/claxedo-server/src/authority/adapters/d1/authorization.ts`. The
principal is a user and, when a request carries one, the actor acting for
them; the resource names its kind; the action is one of a closed set per
kind:

| Resource | Actions |
|---|---|
| `org` | `member`, `administer`, `own` |
| `project` | `read`, `write`, `admin`, `owner`, needing a project role of at least `viewer`, `editor`, `admin`, `owner` |
| `workspace` | `open`, `operate`, `create_session`, `assign_host`, `administer` |
| `session` | `read`, `send`, `control`, `manage_shares` |

The same rules come in two more shapes, so a statement that writes can carry
its own guard: `maySql(principal, action, row)` is the rule as a SQL
predicate over a row already in the query (a table alias), and
`mayGuard(principal, action, resource)` is `exists (...)` of it. Nothing
else on D1 decides access: the workspace, session, host access, channel
runtime, audit, org member, team and project member authorities and the
Agent Plugins activation and source stores all ask it. Each request resolves
its signed caller to an active human principal once (`requireHuman` in
`access-context.ts`); an agent actor never passes it.

That resolution is cached for the request, so it is never the last word on
a write. Every write asks its rule again inside the statement or batch that
makes it: a guard in the write's own `where`, or `batchUnder(database, guard,
statements)`, which puts the guard as the batch's first
`authority_batch_assertions` row (`activeGuard(principal)` when the write
names no resource). A suspension, a removal or a lost workspace between the
check and the write aborts the whole batch with 403.

Every rule first requires an active principal (an active user, and an
active actor that belongs to them) and an active membership of the
resource's org. Then:

- a workspace answers every action to its owner (`workspaces.owner_user_id`)
  alone, while it and its project are live (`assign_host` also reaches a
  retired local worktree, so its assignment can be taken down);
- a session answers `read` to its workspace's owner and to the holder of a
  share on it, `send` to its workspace's owner and the holder of a `send`
  share, and `control` and `manage_shares` to its workspace's owner alone; a
  share reaches a human actor only, and only while the workspace's owner is
  an active user standing in the organization;
- a project answers the action when the principal's project role is at least
  that role;
- an org answers `member` to an active member, `administer` to its owners and
  admins, `own` to its owners.

## Who may change what

| Change | Who | Refused with |
|---|---|---|
| Invite a member, change a member's role, remove a member | org owners and admins | `org_admin_required` |
| Grant, change or remove the `owner` role | org owners | `org_owner_required` |
| Demote or remove the founding owner | nobody, which is what keeps every org owned | `org_owner_protected` |
| Create a team, set up the default team | org owners and admins | `org_admin_required` |
| Add or remove team members, grant or revoke a team's project role | org owners and admins | `team_not_found` |
| Grant or revoke one person's project role | project admins (org owners and admins included) | `project_admin_required` |
| Read a project's access listing | project admins (org owners and admins included) | `project_admin_required` |
| Create a workspace in an org | org owners and admins | `workspace_authorization_denied` |

A team member, a team's project and a member grant's grantee must all belong
to the same org (`team_member_org_membership_required`,
`project_member_org_membership_required`, `project_not_found`). A project's
owner is never granted or revoked (`project_member_owner_immutable`). A
project the caller has no role on answers `project_not_found`. Authorization
comes before existence: an organization the caller does not administer
answers `org_admin_required` whether or not it exists, and a team in such an
organization answers `team_not_found` like an absent one.

Adding a member writes the membership in any state, which is how a removed
member is reinstated; changing a role changes only a membership still active
when the write runs, so a role change racing a removal cannot undo it.
Admitting a user-deployed identity is the same add, under the same owner
rules.

Removing an org member revokes, in the same D1 batch, their team memberships
in that org's teams, their member grants on its projects, the session shares
naming them and the shares they made on their own workspaces' sessions, their
session participations in the org, their runtime access tokens in the org,
and the session tokens their shares admitted. A project or workspace they own stays theirs and
admits them to nothing without the membership. Re-admitting them restores
none of it. Every decision reads the rows at request time, so the removed
person's next request is refused.

A runtime access token's activity is re-read against `may` at check time:
a workspace token needs its holder to still `operate` the workspace, a
session token needs its holder to still `read` the session, which a
suspended owner's session no longer answers to anyone. Removing the
owner from the org revokes their tokens outright, because re-admission would
otherwise bring the old token back to life. A share holder's session token
records the share that admitted it (`runtime_access_tokens.share_grant_id`;
`admittingShareSql` picks the share naming them directly, then one through a
team, then one through their organization). Revoking a share revokes exactly
the tokens it admitted, whoever its target reaches by then, and removing a
person from a team revokes their tokens that team's shares admitted, so a
later share or readmission never revives them. Lowering or revoking a project
grant and a change of org role reach no workspace or session and revoke no
token, and no change revokes a workspace owner's own token.

Setting up the default team creates only what is missing: the team, a
membership for each org member who never had one, and an editor grant on each
project it never had one on. A membership or grant an admin revoked or
re-roled stays as they left it.

Every membership and grant change writes an `authority_audit_events` row in
the batch that makes it, attributed to the caller, whose metadata names the
org, the team or project, the target person, and the role `before` and
`after` (null when there was none or is none); a set change such as the
default team's setup writes one row per target. Every founding owner's
membership (a personal org, a created org, a user-deployed deployment's
configured or claimed owner) writes one too, attributed to the founder, and
only the first time. The row carries the change's complete guard, so a change
the guard refuses, or one that finds nothing to change (the role already in
place, the member already gone), writes no row. The audit table's
per-deployment row cap evicts deny and MCP rows only; access-change rows
(`org.*`, `team.*`, `project.member.*`) are never evicted.

Organization membership grows through an accepted invitation. An admin submits an email and role; the request never looks up an account and answers `202 {"message":"invitation sent"}` for both known and unknown addresses. Only owners may invite with the owner role. The control plane stores the normalized address and a SHA-256 token hash in `org_invitations`; the raw 256-bit token goes only to the deployment's `AuthEmailSender` and the invitee's link.

Invitations expire after seven days, are single-use, and may be revoked by an org admin; creating and revoking one each write an `org.invitation.*` audit row attributed to the admin. A duplicate pending normalized address in the same org returns `409 org_invitation_pending` without another send or token. Creation is limited to 20 per org per rolling hour, including revoked and failed deliveries; `429 org_invitation_rate_limited` refuses excess requests. Acceptance requires the signed caller's verified address from Better Auth `AUTH_DB` to match the invited address. The membership, its `org.member.added` audit (attributed to the accepting user and naming `invitationId` and `inviterUserId`), and token consumption run in one D1 batch. The same transaction rechecks that the inviter still administers the organization (still owns it when granting owner). An existing active member changes role through the member update route; an invitation cannot change that member's role. A revoked membership may join again through a new invitation without restoring its revoked grants.

The link opens `/invitations#<token>` in the app. A person without an account signs up, verifies their email, and returns to that page for the same signed accept call. A user-deployed instance admits a signed-in person other than its owner only while an invitation to their verified address is pending: their first signed request then creates their identity with no membership, and a stranger stays `auth_unavailable`. The founding owner's bootstrap is separate from invitation membership. `org_invitation_admissions` records which invitation admitted a control-plane user; admission rechecks the invitation and inviter in its write batch. Revoking the invitation retires a user it admitted that has no membership records, owns no organization and has no other pending invitation: its identity link is deleted, so its next sign-in is refused and a later invitation admits it afresh, and its user and actor are marked deleted and revoked. Audit rows, agent settings and the Better Auth account in `AUTH_DB` stay.

The Worker composes `AuthEmailSender` through Cloudflare Email Service’s `EMAIL` binding with `CLAXEDO_EMAIL_FROM`. With no sender composed, creating an invitation answers `503 org_invitation_delivery_unavailable`. A delivery failure revokes the undelivered invitation and preserves the generic 202 receipt, so sender failures cannot reveal whether a recipient address has an account. Delivery health must be monitored by the deployment's sender.

## Routes

All under `/api/control`, signed, mounted by `OrgTeamControlRoutes`
(`packages/claxedo-server/src/session/routes/org-team-routes.ts`). An
authority that stores none of this answers `501 not_implemented`.

| Route | Does |
|---|---|
| `GET /orgs`, `POST /orgs` | the caller's orgs; create a collaborative org |
| `GET /orgs/:orgId/members` | members with `role` and `joined_at` |
| `POST /orgs/:orgId/invitations` | create an invitation from `email` and `role`; generic 202 receipt |
| `GET /orgs/:orgId/invitations` | admins list invitation metadata; no token or hash |
| `DELETE /orgs/:orgId/invitations/:invitationId` | admins revoke a pending invitation |
| `POST /invitations/accept` | signed invitee submits `{ token }` in the body with a matching verified address; adds and audits the membership |
| `PATCH /orgs/:orgId/members/:userPublicId` | change `role` |
| `DELETE /orgs/:orgId/members/:userPublicId` | remove, with the cascade above |
| `GET`, `POST /orgs/:orgId/teams`; `POST /orgs/:orgId/ensure-default-team` | teams; create what the default team is missing (org admins) |
| `GET`, `POST`, `DELETE /teams/:teamId/members` | a team's members; `POST` takes an optional `role` (`member` by default, `admin` or `owner`) and answers any other value `400 team_member_role_invalid` |
| `GET`, `POST`, `DELETE /teams/:teamId/projects` | a team's project grants (`projectId`, `role`) |
| `POST /projects/:projectId/members` | grant or change one person's role (`userPublicId`, `role`); a revoked grant is granted again |
| `DELETE /projects/:projectId/members/:userPublicId` | revoke it |
| `GET /projects/:projectId/access` | every person or team that reaches the project, one entry per source: `owner`, `member`, `team:<teamId>` or `org-role` |

The signed desktop reaches the same routes through the named operations
`org.invitations.*`, `org.members.*`, `team.members.*`, `team.projects.*`, `project.members.*` and
`project.access` (`docs/tech-docs/desktop-hosted-operation-matrix.md`).

## Resource hierarchy

```text
People: Org → Teams → members → roles
Code:   Project → Workspace → Session → session share grants
```

A workspace is a folder on its owner's machine, or a cloud sandbox, and it
belongs to its owner (`workspaces.owner_user_id`), the person who created or
placed it. Org roles, project roles (a project `owner` membership row
included), member grants and team grants never reach a workspace, a session
on it, or the machine it runs on; nobody is added to a machine or a folder,
and no row names a person on a workspace.

What the owner alone may do: list and open the workspace, see where it is
placed and whether its machine is serving it, reach the workspace-scoped
surfaces (files, terminals, processes, git), assign it to a machine or
unassign it, reach it over a channel, read Agent Plugins runtime state for
it, mint a runtime access token that reaches the whole workspace, and create
a session on it. Forking is creating a session, so it is the owner's alone
too. The owner still needs an active membership of the workspace's org;
removing them from the org takes all of it away.

The only thing that crosses people is a session share on one session, at
level `follow` or `send`, and it is the whole admission:

```text
may read the session (its transcript, its live and replayed events)
  = owns its workspace, or holds a user-, org- or team-targeted share on it

may send (prompt, answer a permission or a question, abort)
  = owns its workspace, or holds a `send` share on it

may control the session (shell, permission mode, delete, fork, revert,
  unrevert, command, summarize, title and config edits, goal transitions,
  worktree writes) and manage its shares
  = owns its workspace
```

A share never opens the workspace, lists it or its other sessions, reaches
its files, terminals or machine, creates or forks a session, or mints a
token beyond its one session. The owner's active actors, their agents
included, act through workspace ownership, and a share is the only way
anyone else reaches a session. Only the owner may add or revoke shares (`session_share_admin_required`
otherwise), and a share may be offered only to a member of the session's
organization (`session_share_target_outside_organization`). Listing a
session's shares answers a session the control plane never registered only
to its workspace's owner, with an empty list; to anyone else it, another
person's session and an unknown workspace are the same refusal.

The runtime names which class a write is (`sessionAccessWriteClass` in
`packages/session-core/src/session-access-policy.ts`: `agent_turn` is
`send`, `session_control` is `control`) and the session authority answers
it. Read and write checks live in both the managed route policy and the
storage authority so alternate clients cannot bypass the rule.

Every Runtime Access Token and Relay Host Token names its reach in a
`scope` claim: `workspace` on the owner's token, `session` with the
session's id in `session_id` on a share holder's. The verifier
(`tokenScopeClaims` in `packages/workspace-relay/src/auth.ts`, the relay's,
the runtime's and the injected-verifier path alike) refuses a token that
names neither or both, so a token minted before reach was named reaches
nothing. A share holder reaches the runtime with a session-scoped token:
`GET /api/control/workspaces/:id/connection?sessionId=` checks `read` on the
session and mints a `viewer` token scoped to it, recorded with its
`session_id`. The relay and the runtime verify that scope instead of
recomputing anyone's role: `sessionScopeReaches` in
`packages/workspace-relay-protocol/src/index.ts` admits only that session's
routes, its events on `/api/wr/events?sessionID=`, and question replies, and
refuses everything else with 403 `relay_scope_denied`; the runtime's managed
authority refuses a scoped token on any other session
(`session_scope_denied`) and the control-plane oracle refuses a scoped proof
wherever the whole workspace or host is asked for. A workspace-scoped token
is minted only for the workspace's owner.

The runtime admits a caller on the session a question or permission reply
names before it resolves the request id, and looks the id up only among that
session's requests, so another session's request and an unknown one answer
the same 404 `interaction_not_found`. A file, diff or git request that
reaches no session's worktree acts on the machine itself: a relayed caller is
admitted to it by the current host authority (`authorizeHost`) on every
request, so a relay host token whose parent token was revoked reads and
writes nothing there; the machine's own unrelayed user keeps the local
decision.

A session spends its owner's accounts whoever sends: a turn's connection
credential binds the workspace owner's partition (`connectionTurnOwner` in
`packages/claxedo-server/src/connections/turn-owner.ts`), resolved before the
turn's lease is taken, and a turn whose owner cannot be resolved is refused
with 403 `session_owner_unresolved`.

Session privacy protects transcript-derived content: metadata, messages,
prompts, tool activity, questions, permissions, checkpoints, and live or
replayed session events. A `send` share on a session whose workspace is
placed on a machine is the consent that exposes that machine's execution
surface to the grantee (the agent runs with that machine's files), which is
why the People control asks the granter to acknowledge it before a `send`
grant.

## Actor identity and attribution

The existing `users` registry is the actor registry for humans and agents.
Signed managed access carries verified `actor_id` and `actor_kind` claims from
the control plane through the relay to the runtime. Request bodies cannot
assert an actor. Unsigned local use remains anonymous in the UI; a signed
deployment applies an explicit policy to missing actor identity, and managed
session and event boundaries require actor claims. Actor claims participate in the relay RHT cache key so one
actor's cached host token cannot be served to another actor.

An admitted user message stores its verified author actor. OpenCode event names
and standard fields remain unchanged; display data is exposed through an
optional `claxedo.author` extension containing only a public actor ID, display
name, avatar URL, and kind. Internal authority IDs, issuer strings, and raw
subjects never enter the event projection. The app renders an avatar when
available, then initials, then the existing generic user icon. Unsigned messages
retain their existing representation.

## Live delivery and revocation

Every live or replay subscription carries its verified actor, org, token
scope, and connection identity. The same session-access decision filters live
fan-out, replay, reconnect, proxied streams, and transcript-bearing compatibility
events. Visibility-specific replay sequencing prevents filtered events from
appearing as data-loss gaps.

Org membership removal, team membership removal and session share revocation
revoke the affected user's runtime access tokens. Open connections are closed by the hosting adapter's revocation check;
the relay polls every 30 seconds and caches a positive revocation result for
at most 10 seconds, with every lifetime capped by token expiry. Revoked sockets
close with policy code `1008`. WebSocket origins are evaluated against the
deployment's configured `allowedOrigins` before upgrade.

An isolated runtime rechecks session authority through a narrow control-plane
oracle. The runtime forwards its already-verified RHT as an
opaque proof; the oracle verifies the current relay signature and expiry, then
derives actor, workspace and session scope only from signed claims. An expired proof terminates
the stream before its next session-derived event. The client reconnects with a
fresh RAT/RHT and resumes through `Last-Event-ID`.

A runtime's `sessionAuthority` marker (`local` or `managed-private`,
`packages/session-core/src/session-access-policy.ts`) is a declaration
of how it was composed, carried on the host's heartbeat and read by clients
to know whether a session must be reserved first. It decides nothing about a
request. What decides registration, turn admission and event privacy is the
request's provenance, `sessionRequestProvenance`: `loopback-direct` is the
machine's own user and gets the local-owner lifecycle; `relay-replayed` is a
caller the relay verified and gets the private-session lifecycle through the
control plane's authority, which fails closed when that authority is
unavailable. A desktop daemon that publishes its workspaces mounts one policy
for both (`localHostSessionAccessPolicy`,
`packages/claxedo-local-server/src/deployments/local/host-session-authority.ts`)
and stamps provenance at ingress
(`workspace/runtime-dispatch/ingress-provenance.ts`): a request that claims
to have come through the relay but cannot be verified is refused, never
treated as local. A cloud sandbox's runtime admits nobody without a verified
actor.

## Client authority continuity

Authorization is complete only when the client preserves the identity and
placement returned by the managed boundary:

- a central session carries an explicit `central:<session-id>` reference plus
  its authoritative workspace id;
- a session on a workspace another host serves keeps its signed workspace
  backing (`workspace:<id>`), while a session on a directory the attached
  server serves itself keeps that filesystem directory;
- direct-route resolution opens an explicit central session through the central
  transport instead of reclassifying it from a tool-sandbox directory;
- session resource and hydration keys include transport authority so cached
  local data cannot satisfy a later central or signed workspace read;
- lifecycle inventory updates patch known canonical rows and do not invent a
  tenant or placement for an unknown session;
- message snapshot/live merges preserve producer order, known authors, and
  intermediate task parts;
- terminal subagent lifecycle remains available to authorized replay, and task
  cards read child lifecycle rather than treating a parent tool error as the
  child result.

The app may optimistically represent a user action, but canonical server data
owns the final session placement, message membership, author, model, and
lifecycle. An empty canonical result is authoritative; the client must not fall
back to stale data from another transport.

## Private pages

A document records its canonical user creator id on creation. After the project
read gate, only its creator or an explicit share can read it. Organization and
project administrators have no private-page override. A person target must be an
active member of the page's organization; a team target must belong to that
organization, and its members must still be active organization members. Shares
have `view` or `edit` permission. Only the creator manages shares and archives or
restores the page. Creating or revoking a share is a write of the document
authority (`d1DocumentAccess`) that re-asks, inside its D1 batch, the
creator's active user and actor and their read on the page's project, and a
person or team target's standing in the page's organization; the hosted
index refuses any change to a page's id, organization, project or creator,
so the entry the decision read cannot have moved.

`authorizeDocument` in `packages/claxedo-server-core/src/documents/access.ts`
owns this policy, and `filterDocuments` applies it to listings with one
membership, project and share read per organization and project. Hosted routes,
the local document service, runtime writeback and the runtime's hydration
callback (`POST /documents/:id/runtime-authorization`) use it. MCP and the CLI
open a page through `/documents/:id/agent-open`, which authorizes on the server. Document access denials return 404, including denials
after share revocation.

The share API is `GET/POST/DELETE /documents/:id/shares`; DELETE accepts
`{ "share_id": "..." }`. A link share is view only. Its token is returned once
on creation, and only its SHA-256 hash is stored in `document_shares`. Public
`GET /p/:token` is rate limited and returns no cached content. Revoked links and
archived documents return 404. A link reads its page only while the page's
creator could still read it. A link grants no machine or session access.

Cloudflare Workers mount the hosted backend with `CLAXEDO_DOCUMENTS` (R2) and
`CONTROL_PLANE_DB` (D1 shares). The local backend serves only the machine's own
person: a signed caller gets `document_signed_access_unavailable` and a share
request gets `document_sharing_unavailable` (both 501). Creation requires a
creator; existing rows without one remain unreadable. No stored row is
backfilled or assigned a guessed creator.

Hosted Pages live in R2 and hydrate only into the selected session's runtime.
A page on a machine is served by that machine's local backend alone; no route
carries a machine's pages to the hosted control plane or to another runtime.

## Scope boundaries

The OpenCode HTTP and event contract remains the external compatibility
boundary.

Two event streams exist. The control plane's `GET /api/cp/events` carries
notices only (provision, worktree readiness, Page and session-share
doorbells, a workspace's inventory change), never a session's content.
`eventVisibleTo` (`packages/claxedo-server-core/src/platform/http/event-visibility.ts`)
filters each notice per subscriber, live and on replay: a signed subscriber
receives a share doorbell naming them and the quota doorbell, and no Page,
provision, inventory or worktree notice; the hosted room admits share
doorbells alone. A workspace runtime's `GET /api/wr/events` carries
that runtime's session frames, and the arm is decided per request
(`authorizeSessionEventScope`,
`packages/session-core/src/routes/session-event-privacy.ts`): a
`loopback-direct` request reads the whole stream, because it is the
machine's own user; a `relay-replayed` principal the workspace authority
admits reads it unscoped and the session authority decides per session what
reaches it (the workspace's owner is not special); one it refuses is
answered 403 `workspace_event_stream_denied` and reopens one session under a
lease. The daemon's host aggregate (`wr/events` with no workspace named,
declared in its bootstrap body as `events.hostAggregate`) refuses any reader
that is not loopback-direct.

Whether a client must hold a signed session at all is the server's
declaration too, in the same body: `deployment.issuesSessions`, derived from
the composition's own control-plane auth config
(`packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts`
for a daemon, `packages/claxedo-server/src/routes/hosted/shell.ts`
for the hosted central). A desktop daemon says `false`; the hosted central
says `true`, and so does a composition whose signed auth is misconfigured,
because a client that read it as a personal machine would enter a shell where
every route then refuses it. Only an explicitly local-only composition says
`false`.

The client cannot derive this: a build flag describes the bundle rather than
the server it reached. The app resolves the declaration
before its first render
(`bootstrapCatalog` in `packages/claxedo-app/src/server/wire/placements.ts`) and three
surfaces read it: the sign-in gate (`CloudAuthGate`), the browser identity
provider's startup (`startBrowserAuth`, which loads no provider SDK against a
server that issues no sessions), and the first-project canvas. The request
carries no credential, because the caller that most needs the answer is the
one who has not signed in; a signed server answers an anonymous caller the
declaration and nothing behind it.

Invite and accept UI, org and team switching, personal-to-org workspace transfer,
session-share management UI, and presence UI are tracked product
surfaces. Presence derives from identity-attached subscriptions. External
artifacts such as pull requests and Slack messages remain governed by their
destination systems.

The Org / Team glossary is the naming source for invite strings before those
strings are propagated across locales.
