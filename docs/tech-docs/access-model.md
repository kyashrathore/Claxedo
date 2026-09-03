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
and `owner`. Workspace roles are `viewer`, `editor`, `admin`, and `owner`. Org
owner/admin authority projects to workspace admin; an org member projects to
workspace viewer unless narrowed by team project grants. Direct workspace,
project, team-project, and share grants combine additively, with the highest
effective role winning.

Session authority is conjunctive:

```text
may access a private session
  = has the required workspace authority
  AND is the session creator, an active participant,
      a user- or team-targeted session share grant (evaluate-time),
      or an org admin
```

The creator is enrolled when the session is created. The creator, an org admin,
or a team admin for an in-scope project may add and remove participants and
session share grants; a participant cannot enroll others. Read and write checks
live in both the managed route policy and the storage authority so alternate
clients cannot bypass the rule. Private sessions are not hidden from org
admins (support/compliance).

Session privacy protects transcript-derived content: metadata, messages,
prompts, tool activity, questions, permissions, checkpoints, and live or
replayed session events. Files and working-tree edits remain governed by
workspace access and are visible to workspace members. Sharing a user-hosted
workspace is a distinct consent action because it exposes the working tree and
execution surface.

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

Self-hosted caller-owned embedded runtimes are the explicit local policy scope:
they preserve unsigned single-user behavior and do not become a managed
multiplayer boundary. Relay- and private-network-exposed runtimes require the
authority-backed policy and fail closed when the oracle is unavailable.

## Client authority continuity

Authorization is complete only when the client preserves the identity and
placement returned by the managed boundary:

- a central session carries an explicit `central:<session-id>` reference plus
  its authoritative workspace id;
- workspace-runtime sessions keep their signed workspace backing, while local
  sessions keep their filesystem transport directory;
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

Hosted central event visibility defaults to deny for session-derived content
unless the subscription has an authority decision. Self-host compatibility
streams retain the explicit local policy described above; that local boundary
is not presented as private multiplayer isolation.

Invite and accept UI, org and team switching, personal-to-org workspace transfer,
participant and session-share management UI, and presence UI are tracked product
surfaces. Presence derives from identity-attached subscriptions. External
artifacts such as pull requests and Slack messages remain governed by their
destination systems.

The Org / Team glossary is the naming source for invite strings before those
strings are propagated across locales.
