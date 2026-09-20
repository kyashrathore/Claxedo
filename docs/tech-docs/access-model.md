# Access model

Claxedo presents an **Org** (company/tenant) and **Teams** (access groups inside
an org). A personal org is created implicitly for every user, preserving
unbranched solo onboarding. Collaborative orgs are created explicitly and begin
with their creator as owner. Nested teams, invites, active org/team navigation,
and workspace transfer are product surfaces layered on this model.

## Resource hierarchy

Access combines a people axis with a code axis:

```text
People: Org → Teams → members → roles
Code:   Project → Workspace → Session → participants / session share grants
```

A project represents one repository inside one org. It has a globally unique,
opaque `project_id`; `(org_id, repo_key)` is the canonical repository identity
used to reuse a project inside an org. The same repository opened by two orgs
produces two isolated projects. Teams receive project access through
`team_project_grants`; they do not own projects.

A workspace is a checkout and execution location. Every workspace is created
with both `org_id` and `project_id`; those identities are immutable. Solo
creation resolves the caller's personal org. Creating a workspace in a
collaborative org requires an effective workspace role of editor or above.
Creating a workspace never moves an existing personal workspace into another
org; workspace transfer is an explicit future billing operation.

## Roles and authority

Org roles are `member`, `admin`, and `owner`. Team roles are `member`, `admin`,
and `owner`. Workspace roles are `viewer`, `editor`, `admin`, and `owner`. A
workspace role is computed from membership, never handed to one person by
another: the workspace's owner is `owner`, and everyone else holds the highest
of their `project_memberships` row, their org role (an org member's `viewer`
is withheld when the workspace's `org_member_visible` is 0), and the best
`team_project_grants` row of a team they are on in that org
(`workspaceRoleForUser` in
`packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority-store.ts`,
`workspaceAccessSql` in
`packages/claxedo-server/src/authority/adapters/d1/workspace-authority.ts`).

What that role is FOR: seeing that the workspace's placement exists (which
machine it runs on, its directory there), the workspace-scoped surfaces
the Relay Host Token has always gated (files, terminals, processes, git),
and being offerable a session share. An organization is a grouping of
people. It is not an execution environment and it grants nothing on any
machine, runtime or workspace folder: there is no concept of adding a
member to a machine or a folder, no membership row on a workspace, and no
rank on an organization or a workspace that admits a person to a session.

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
the Bun relay polls every 30 seconds and caches a positive revocation result for
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

Invite and accept UI, org and team switching, personal-to-org workspace transfer,
participant and session-share management UI, and presence UI are tracked product
surfaces. Presence derives from identity-attached subscriptions. External
artifacts such as pull requests and Slack messages remain governed by their
destination systems.

The Org / Team glossary is the naming source for invite strings before those
strings are propagated across locales.
