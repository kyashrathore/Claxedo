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
  them. `projectRoleRankSql` in
  `packages/claxedo-server/src/authority/adapters/d1/project-role.ts`
  computes it, and every project decision on D1 reads it. Project access
  governs the project (its access listing, its grants) and never a
  workspace; see the resource hierarchy below.

## Who may change what

| Change | Who | Refused with |
|---|---|---|
| Add a member (including a user-deployed identity admission), change a member's role, remove a member | org owners and admins | `org_admin_required` |
| Grant, change or remove the `owner` role | org owners | `org_owner_required` |
| Demote or remove the founding owner | nobody, which is what keeps every org owned | `org_owner_protected` |
| Create a team, set up the default team, add or remove team members, grant or revoke a team's project role | org owners and admins | `org_admin_required` |
| Grant or revoke one person's project role | project admins (org owners and admins included) | `project_admin_required` |
| Read a project's access listing | project admins (org owners and admins included) | `project_admin_required` |
| Create a workspace in an org | org owners and admins | `workspace_authorization_denied` |

A team member, a team's project and a member grant's grantee must all belong
to the same org (`team_member_org_membership_required`,
`project_member_org_membership_required`, `project_not_found`). A project's
owner is never granted or revoked (`project_member_owner_immutable`). A
project the caller has no role on answers `project_not_found`.

Adding a member writes the membership in any state, which is how a removed
member is reinstated; changing a role changes only a membership still active
when the write runs, so a role change racing a removal cannot undo it.
Admitting a user-deployed identity is the same add, under the same owner
rules.

Removing an org member revokes, in the same D1 batch, their team memberships
in that org's teams, their member grants on its projects, their direct
session shares and session participations in the org, and their runtime
access tokens in the org. A project or workspace they own stays theirs and
admits them to nothing without the membership. Re-admitting them restores
none of it. Every decision reads the rows at request time, so the removed
person's next request is refused.

A runtime access token is minted only by the workspace's owner, and its
activity is re-read against their rank at check time. The one change that
takes that rank away is removing the owner from the org, so it is the one
change that revokes tokens: re-admission gives the rank back, and without the
revocation the old token would work again. Lowering or revoking a grant,
leaving a team and a change of org role touch no workspace rank and revoke
no token.

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

An email is resolved only after the caller is found to administer the org the
request names, so a caller who administers no org learns nothing from the
answer. That is the whole guarantee. In the user-deployed posture the
deployment has one org, so only its owners and admins can learn whether an
address has a verified account. In the hosted posture any signed user can
create an org and administer it, so any signed user can learn that.

## Routes

All under `/api/control`, signed, mounted by `OrgTeamControlRoutes`
(`packages/claxedo-server/src/session/routes/org-team-routes.ts`). An
authority that stores none of this answers `501 not_implemented`.

| Route | Does |
|---|---|
| `GET /orgs`, `POST /orgs` | the caller's orgs; create a collaborative org |
| `GET /orgs/:orgId/members` | members with `role` and `joined_at` |
| `POST /orgs/:orgId/members` | add an existing account by `userPublicId`, `email`, `tokenIdentifier` or `providerSubject`, with `role`; an email names the Better Auth account that verified it (`AUTH_DB`), and a deployment without that lookup answers `org_member_email_unsupported` |
| `PATCH /orgs/:orgId/members/:userPublicId` | change `role` |
| `DELETE /orgs/:orgId/members/:userPublicId` | remove, with the cascade above |
| `GET`, `POST /orgs/:orgId/teams`; `POST /orgs/:orgId/ensure-default-team` | teams; create what the default team is missing (org admins) |
| `GET`, `POST`, `DELETE /teams/:teamId/members` | a team's members; `POST` takes an optional `role` (`member` by default, `admin` or `owner`) and answers any other value `400 team_member_role_invalid` |
| `GET`, `POST`, `DELETE /teams/:teamId/projects` | a team's project grants (`projectId`, `role`) |
| `POST /projects/:projectId/members` | grant or change one person's role (`userPublicId`, `role`); a revoked grant is granted again |
| `DELETE /projects/:projectId/members/:userPublicId` | revoke it |
| `GET /projects/:projectId/access` | every person or team that reaches the project, one entry per source: `owner`, `member`, `team:<teamId>` or `org-role` |

The signed desktop reaches the same routes through the named operations
`org.members.*`, `team.members.*`, `team.projects.*`, `project.members.*` and
`project.access` (`docs/tech-docs/desktop-hosted-operation-matrix.md`).

## Resource hierarchy

```text
People: Org → Teams → members → roles
Code:   Project → Workspace → Session → participants / session share grants
```

A workspace is a folder on a machine, or a cloud sandbox, and it belongs to
its owner (`workspaces.owner_user_id`), the person who created or placed it.
A person's role on a workspace, `workspaceRoleRankSql`, is `owner` for its
owner and nothing for anyone else. Org roles, project roles (a project
`owner` membership row included), member grants and team grants never reach
a workspace or the machine it runs on; nobody is added to a machine or a
folder, and no row names a person on a workspace. `org_member_visible` changes
no one's workspace role.

What the owner's role unlocks: listing and opening the workspace, seeing
where it is placed and whether its machine is serving it, the
workspace-scoped surfaces the Relay Host Token gates (files, terminals,
processes, git), assigning it to a machine or unassigning it, channel access
to it, Agent Plugins runtime reads for it, and runtime access tokens for it.
The owner still needs an active membership of the workspace's org; removing
them from the org takes all of it away.

The only thing that crosses people is a session share, `follow` or `send`,
on one session. It admits the grantee to that session, and workspace open,
channel access and runtime access tokens admit a share grantee as a viewer of
that session's workspace (`SESSION_SHARE_WORKSPACE_ACCESS_SQL` in
`packages/claxedo-server/src/authority/adapters/d1/workspace-authority.ts`).

One exception is still in the code. The session layer
(`packages/claxedo-server/src/authority/adapters/d1/session-authority.ts`)
reads the older rank for reserving, forking, starting, adopting and
re-visibility of a session and for adding a participant: the workspace
form of `projectRoleRankSql`, where org owners and admins are `admin` on
every workspace of the org and, on a workspace whose `org_member_visible` is
1, a member grant (at most `admin`), a team grant or plain org membership
counts. So today an org member can still reserve, fork and start a session
on another member's workspace through the session layer. Lane C1 removes
that.

The workspace role stops at the session. A session share, at level `follow` or
`send`, is the only grant one person makes to another, and it is the whole
admission:

```text
may read a private session
  = is the session creator, an active participant,
    or the holder of a user-, org- or team-targeted session share (evaluate-time)

may drive its agent (prompt, answer a permission or a question, abort)
  = is the session creator, an active participant,
    or the holder of a `send` share

may control the session (shell, permission mode, delete, fork, revert,
  unrevert, command, summarize, title and config edits, goal transitions,
  worktree writes)
  = is the session creator or an active participant
```

Org admin standing and workspace role rank admit no one to a session, for read
or for write; `follow` carries reading and the live stream and stops there, and
a `send` share carries the agent's turn and never control of the session.
The runtime names which of the two a write is (`sessionAccessWriteClass` in
`packages/workspace-runtime/src/session-access-policy.ts`) and the authority
answers it. The
creator is enrolled when the session is created, and only the creator may add
or remove participants and session shares (`session_share_admin_required`
otherwise); a share may be offered only to a member of the session's
organization (`session_share_target_outside_organization`). Read and write
checks live in both the managed route policy and the storage authority so
alternate clients cannot bypass the rule.

Session privacy protects transcript-derived content: metadata, messages,
prompts, tool activity, questions, permissions, checkpoints, and live or
replayed session events. Files and working-tree edits remain governed by the
workspace role; a `send` share on a session whose workspace is placed on a
machine is the consent that exposes that machine's execution surface to the
grantee (the agent runs with that machine's files), which is why the People
control asks the granter to acknowledge it before a `send` grant.

## Actor identity and attribution

The existing `users` registry is the actor registry for humans and agents.
Signed managed access carries verified `actor_id` and `actor_kind` claims from
the control plane through the relay to the runtime. Request bodies cannot
assert an actor. Unsigned local use remains anonymous in the UI; a signed
deployment applies an explicit policy to missing actor identity. The token
rollout order is accept optional claims, mint actor-bearing RATs and RHTs, wait
one maximum RAT lifetime, then require actor claims at managed session and
event boundaries. Actor claims participate in the relay RHT cache key so one
actor's cached host token cannot be served to another actor.

An admitted user message stores its verified author actor. OpenCode event names
and standard fields remain unchanged; display data is exposed through an
optional `claxedo.author` extension containing only a public actor ID, display
name, avatar URL, and kind. Internal authority IDs, issuer strings, and raw
subjects never enter the event projection. The app renders an avatar when
available, then initials, then the existing generic user icon. Unsigned messages
retain their existing representation.

## Live delivery and revocation

Every live or replay subscription carries its verified actor, org, workspace
role, and connection identity. The same session-access decision filters live
fan-out, replay, reconnect, proxied streams, and transcript-bearing compatibility
events. Visibility-specific replay sequencing prevents filtered events from
appearing as data-loss gaps.

Membership removal and role downgrade revoke the affected user's runtime access
tokens. Open connections are closed by the hosting adapter's revocation check;
the relay polls every 30 seconds and caches a positive revocation result for
at most 10 seconds, with every lifetime capped by token expiry. Revoked sockets
close with policy code `1008`. WebSocket origins are evaluated against the
deployment's configured `allowedOrigins` before upgrade.

An isolated runtime rechecks creator/participant authority through a narrow
control-plane oracle. The runtime forwards its already-verified RHT as an
opaque proof; the oracle verifies the current relay signature and expiry, then
derives actor and workspace only from signed claims. An expired proof terminates
the stream before its next session-derived event. The client reconnects with a
fresh RAT/RHT and resumes through `Last-Event-ID`.

A runtime's `sessionAuthority` marker (`local` or `managed-private`,
`packages/workspace-runtime/src/session-access-policy.ts`) is a declaration
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
restores the page.

`authorizeDocument` in `packages/claxedo-server-core/src/documents/access.ts`
owns this policy, and `filterDocuments` applies it to listings with one
membership, project and share read per organization and project. Hosted routes,
the local document service, installation broker reads, runtime writeback and
the runtime's hydration callback (`POST /documents/:id/runtime-authorization`)
use it. MCP and the CLI open a page through `/documents/:id/agent-open`, which
authorizes on the server. Document access denials return 404, including denials
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

Hosted Pages read and write R2 and hydrate into the selected session runtime.
The Worker supplies no machine document relay or remote discovery endpoint.
The self-hosted app mounts `LocalInstallationDocumentBroker` at
`/internal/documents`, and relay-exposed workspace runtimes mount
`LocalDocumentBrokerRoutes` at `/api/wr/local-documents/broker`. Both remain
subject to their installation credentials and document capability checks; the
local backend refuses signed document access. Desktop and local-server runtimes
use embedded exposure and do not mount the runtime broker route.

## Installation order

The control plane installs the target model through expand–migrate–contract
releases so a schema push never requires a value before the resumable migration can populate
it. The migration envelope is operational and is removed by the contract
release; it is not an internal API compatibility promise.

1. expand with optional user identity, project tenancy, workspace tenancy, and
   session provenance fields plus participant/message-author storage;
2. deploy code that writes the target shape and remains able to read rows still
   awaiting migration;
3. run the ledger-backed user, project, project-membership, workspace, and
   session migrations on staging and production;
4. run complete batched contract probes and retain their successful ledger
   output for every deployment;
5. contract the fields to required and remove legacy project fields in a
   separate schema-only release;
6. deploy actor-bearing token policy, identity-aware event delivery, and
   revocation teardown against the contracted model.

SQLite performs the corresponding legacy backfill, validation, table rebuild,
and constraint installation atomically, with a WAL-checkpointed pre-upgrade
snapshot. No migration step reassigns a personal workspace to a team.

## Scope boundaries

The internal schema converges on this model after its operational migration
release; legacy development and staging tenancy rows are migrated or discarded
before contract. The OpenCode HTTP and event contract remains the external
compatibility boundary.

Two event streams exist. The control plane's `GET /api/cp/events` carries
notices only (provision, worktree readiness, document and session-share
doorbells, a workspace's inventory change), never a session's content; hosted, `eventVisibleTo` filters each
notice per subscriber by the authority-internal org id and, for share
doorbells, the recipient. A workspace runtime's `GET /api/wr/events` carries
that runtime's session frames, and the arm is decided per request
(`authorizeSessionEventScope`,
`packages/workspace-runtime/src/routes/session-event-privacy.ts`): a
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
for a daemon or a self-hosted node, `packages/claxedo-server/src/routes/hosted/shell.ts`
for the hosted central). A desktop daemon and an unsigned self-hosted node
say `false`; a signed node and the hosted central say `true`, and so does a
composition whose signed auth is misconfigured, because a client that read it
as a personal machine would enter a shell where every route then refuses it.
Only an explicitly local-only composition says `false`.

The client cannot derive this. A signed node runs its embedded issuer on
localhost, so the URL is the one a daemon has, and a build flag describes the
bundle rather than the server it reached. The app resolves the declaration
before its first render
(`bootstrapCatalog` in `packages/claxedo-app/src/server/wire/placements.ts`) and three
surfaces read it: the sign-in gate (`CloudAuthGate`), the browser identity
provider's startup (`startBrowserAuth`, which loads no provider SDK against a
server that issues no sessions), and the first-project canvas. The request
carries no credential, because the caller that most needs the answer is the
one who has not signed in; a signed node answers an anonymous caller the
declaration and nothing of the machine behind it.

Invite and accept UI, org and team switching, personal-to-org workspace transfer,
participant and session-share management UI, and presence UI are tracked product
surfaces. Presence derives from identity-attached subscriptions. External
artifacts such as pull requests and Slack messages remain governed by their
destination systems.

The Org / Team glossary is the naming source for invite strings before those
strings are propagated across locales.
