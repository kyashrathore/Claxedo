# A host is a machine: one identity for the desktop, the connect host, and the workspaces they serve

Status: proposed 2026-09-19, not reviewed, no implementation authorized.
Builds on `2026-09-14-001-feat-connect-enrollment-foundation-proposal.md`
(investigation) and `2026-09-14-003-feat-connect-implementation-plan.md`
(P1–P3 landed on dev `8bdd4bdbff`; P4–P7 open). Reuses that plan's P7 as
slice 2 here rather than restating it.

## 0. Direct recommendation

Make "which machine serves this workspace" the only fact the product stores,
and derive everything else from it:

- A **host** is a machine with one enrollment identity. The desktop app and
  `claxedo connect` are two shells around the same host connector; neither
  is the "real" one.
- A **workspace** belongs to a host and a directory on it. There is no
  `local` kind and no `user-hosted` kind on the wire; those are what a
  client says when it has answered one question at open time: **is this
  host me?**
- The **wire** follows that answer. Host is me → loopback, no relay, no
  token, works signed out. Host is not me → relay with a runtime access
  token. A cloud VM is a host too; its shell is the provisioner.

What the user sees: one "This machine" entry that is the same thing on the
desktop and on the web, a second machine added by running one command, and
no step where a workspace has to be made "user-hosted" to be reachable.

What this plan does NOT do: route the desktop through the relay to reach
its own machine. Loopback is free and works offline; the unification is in
identity and naming, not in the wire.

## 0.1 Why this refactor, and whether it is justified

**The symptom.** A user with the desktop app installed asks whether they
also need `claxedo connect`, and why the workspace they opened on the
desktop as "local" is "user-hosted" on the web. Both questions have no good
answer today, because the product stores a transport as if it were a kind
and exposes two enrollment paths for one machine.

**Three defects sit under the symptom, and two of them must be fixed
regardless of naming:**

1. A serving desktop lets any org member who can see the workspace reach
   every session and the workspace-wide event stream (B.4). This is a
   privacy hole, already recorded as P7 of the 09-14 plan, and it is fixed
   by slice 2 whether or not the rest of this plan happens.
2. The desktop connector holds the account in its beat path (B.1), so a
   desktop host is the one host that cannot outlive an account lapse the
   way a connect host does. Slice 1, also P7, also independent of naming.
3. The control plane represents "a workspace on the user's own machine" as
   a `cloud` row that happens to have no driver (B.3), and the app
   recognises its own machine by URL shape (E). Neither is wrong today;
   both are the reason every new surface (the streams work, remote access
   onboarding, the composer's environment chip) has to re-learn the
   distinction and carry its own copy of it.

**What the refactor removes**

- Two enrollment paths for one machine, and the product story that goes
  with them. After slice 1 the desktop and `connect` differ only in which
  process holds the connector.
- The driverless-cloud row and the `user-hosted` derivation. A placement
  is a fact; "no driver" was a signal.
- Three copies of the wire decision in the app (event targets, runtime
  request path, placement) and 222 kind literals across 86 files, replaced
  by one resolver with one test file.
- A vocabulary. "local", "cloud", "user-hosted" stop being workspace
  types; "machine" is the only word the user meets.

**What the refactor adds**

- No compatibility bridge: readers and the store move in the same branch,
  so an app and a control plane from different sides of this change do not
  interoperate (user ruling 2026-09-19).
- The app must know its own enrollment id to answer "is this host me".
  Today it knows only "is the URL loopback". The daemon already holds the
  id; exposing it is one route and one read, but it is a new dependency of
  the app on the host identity.
- Request-scoped authorization on the daemon is more code than the
  runtime-wide marker it replaces: provenance stamped at ingress, three
  decision sites reading it, and the rejection of unverifiable relayed
  requests. This is complexity the privacy fix needs, not the naming.
- A data migration on D1 and SQLite, with the usual upgrade tests.

**What it does not touch.** The process model (§2.1), the relay, the
runtime access token, the session share arms, the two event streams, the
cloud provisioner.

**Is it justified?** Slices 1, 2 and 5 are justified on their own: two are
security and durability fixes already owed, and the copy slice removes the
user-visible confusion at almost no cost. Slices 3 and 4 are the
structural payoff and the bulk of the work; their justification is that
every surface built since remote access shipped has paid the kind tax
again, and the streams refactor is about to pay it once more in its event
target selection. The cheap alternative, copy-only (slice 5 without 3 and
4), hides the confusion but leaves the next feature to rediscover it. The
recommendation is: take 1, 2 and 5 now; take 3 and 4 as one follow-up
after the loopback aggregate stream lands, so the event target selection
is rewritten once, not twice.

## 1. Today, observed (dev `e266a9f602`)

Labels are used by the slices below.

**A. Desktop, signed out.** The daemon on loopback is the control plane and
embeds one workspace runtime per local workspace. Workspaces live in the
daemon's own store as `local` worktree rows. Session access is the
permissive `local` policy. Nothing leaves the machine.

**B. Desktop, signed in, remote access on.** `B.1` Main runs a host
connector child. Enrollment goes through an ACCOUNT operation (main holds
the account); heartbeats are signed with the machine key but the enrollment
identity still rides the account. `B.2` Remote access is machine-level: an
app-side driver publishes every local workspace, and every one opened
later, with one `registerUserHostedWorkspace` call each (an assignment POST
plus a beat). It never unpublishes. `B.3` The hosted control plane stores
the published workspace as a `cloud` row with no driver, and its public
backing derives `kind: "user-hosted"` from exactly that absence. `B.4` A
relayed request reaches the embedded runtime with a verified actor stamp
(hop-only header) so authorship is attributed, but the runtime policy is
still `local`: any org member who can see the workspace reaches every
session on it and the workspace-wide event stream. This is the lead the
investigation confirmed live and the open P7.

**C. `claxedo connect` host.** Same host-connector and host-serving packages
as B. Enrollment by invitation token, identity by `enrollment_id`, machine
principal at the control plane, `managed-private` session authority, scope
by root. Everything P1–P3 delivered. A connect host receives no provider
configuration from the control plane (open gap, recorded in the 09-14 plan).

**D. Web, signed in.** Reads the hosted control plane. Every workspace it
opens goes through the relay, including one served by the user's own
desktop under B. The app labels it `user-hosted`.

**E. The app decides the wire by shape.** "Is this workspace on my machine"
is answered by "is the server URL loopback and is the directory a
filesystem path". 86 files in `claxedo-app/src` branch on the workspace
kind; 222 sites name `"cloud"` or `"user-hosted"` literally. The event
target selection, the runtime request path and placement all carry their
own copy of the branch.

The confusion the user reported is B.3 + D + E together: one directory is
`local` in one window and `user-hosted` in another, the desktop app and the
installer look like two products, and nothing in the app can recognise its
own machine when it is reached by another name.

## 2. Target model

Terms (proposed; only "host" is new to the product surface):

- **Host**: an enrolled machine. Fields the control plane keeps:
  `enrollment_id`, owner, display name, scope roots, serving generation,
  liveness. Already exists for C; B moves onto it in slice 1.
- **Placement**: `{ host, directory }`. The one persisted fact about where a
  workspace runs. A cloud VM is a host whose shell is the provisioner and
  whose driver is recorded on the host, not on the workspace.
- **Wire**: `loopback | relay`, computed by the client at open time from
  "placement.host is this machine's enrollment (or this machine has no
  enrollment and the directory is its own)". Never persisted, never sent.
- **Visibility**: who may see the placement exists. Unchanged from today's
  workspace access; publication of a machine's inventory stays an explicit
  machine-level switch.

Flows after the change, same labels:

**A'. Desktop, signed out.** Unchanged. Host = self with no enrollment;
every workspace answers "host is me". Runtime policy is request-scoped
(slice 2), which on loopback-direct requests behaves exactly as `local`
does today.

**B'. Desktop, signed in.** `B'.1` The connector child enrolls and beats as
a machine (P7d). `B'.2` Remote access on = the daemon's inventory is
published under this host's placement; the control plane records
`{host: me, directory}` rows, no driverless-cloud row. `B'.3` The
control plane's backing model has no `user-hosted`; the client derives the
label from the wire. `B'.4` Relayed requests are authorized per request on
verified provenance: private-session lifecycle for relayed, local-owner
lifecycle for loopback-direct (P7a–c).

**C'. Connect host.** Unchanged in substance; loses nothing. Gains the
provider-config delivery if slice 6 is taken.

**D'. Web.** Opens the same placement rows. For a workspace on the user's
own desktop it still uses the relay (the browser is not that machine), but
the label is "This machine · MacBook" from the host record, not a kind.

**E'. One resolver.** `placement → wire` lives in one module; the event
target selection, runtime request path and placement code call it. The
kind literals go.

### 2.1 Process model is unchanged

Both shells already embed: the desktop daemon mounts one runtime per
workspace in-process and dispatches to it without a socket; a `connect`
host serves every runtime in its foreground process and drains them on
shutdown. This plan keeps that. No runtime is spawned per workspace, no
new hop is added on loopback, and a signed-out desktop's request path is
byte-for-byte today's. The only runtime cost introduced is slice 2's
per-request authority consultation for RELAYED requests, which is what a
connect host already pays, plus one control-plane write per session that
becomes reachable remotely. `connect` already refuses to start beside a
live desktop daemon without `--alongside-desktop`, because the desktop
serves the machine under its own enrollment; that guard stays.

## 3. Slices

Each slice is independently shippable and leaves the tree green. Order is
by dependency, not by value; slices 1 and 3 can start in parallel.

### Slice 1 — The desktop beats as a machine (P7d)

Move the desktop connector child from account-enroll + account-heartbeat to
enroll-once-through-main then machine-signed heartbeats, the way `connect`
already does. Enrollment stays interactive (main has the account); the
enroll response's `enrollment_id` hands the child to the machine path.
Delete `host.enrollmentHeartbeat` from the operation matrix and heartbeat
v2 from the control plane.

Definition of done:
- [ ] Desktop connector heartbeats with the machine transport; no account op in the beat path; sign-out still suspends serving and sign-in resumes it (existing `remoteAccessFollow` tests extended). Progress:
- [ ] `host.enrollmentHeartbeat` removed from the operation matrix and inventory test; heartbeat v2 route deleted on D1 and SQLite with the upgrade test. Progress:
- [ ] `real-desktop-signed-cloud.spec.ts` green; a control-plane blip during a beat does not unpublish the machine (the child-supervisor regression stays covered). Progress:

### Slice 2 — Request-scoped session authority on the desktop daemon (P7a–c)

Stamp provenance at the daemon's ingress: `loopback-direct` or
`relay-replayed` (the latter only with a verified stamp; an unverifiable
relayed request is rejected, never treated as local). Make registration,
turn admission and event privacy consult the request's provenance instead
of the runtime-wide `sessionAuthority` marker. Define the local owner for a
signed desktop and what happens to sessions created before remote access
was enabled (product decision Q2 below).

Definition of done:
- [ ] The investigation's §14.1 probe answers 403 for a relayed request on a missing or private session and 404 for the same request over loopback, on a real `startLocalServer`. Progress:
- [ ] Enable, disable and sign-out dispose no runtime; a long turn and a PTY survive all three (existing lifecycle spec extended). Progress:
- [ ] Event privacy: a relayed org member's workspace-level `wr/events` is refused with `workspace_event_stream_denied` unless they hold workspace access, and the session-scoped arm serves only granted sessions; loopback-direct is unchanged. Progress:
- [ ] Tier L/M user-hosted specs green; `session_authority` declared to the control plane is `managed-private` for a serving desktop. Progress:

### Slice 3 — Control plane: a workspace has a placement, not a kind

Replace the driverless `cloud` row that stands for a user-hosted workspace
with a placement: the public workspace JSON carries
`placement: { host_enrollment_id, directory }`, read from the owner's
assignment and the workspace's stored directory, and `backing` is what says
whether the provisioner owns the machine. No compatibility bridge (user
ruling 2026-09-19: none needed): the `access` column, the derived
`kind: "user-hosted"` and every reader of them go in this branch — the
control plane in slice 3, the app in slice 4. The daemon's own worktree rows
are its private store and stay as they are; its only other placement is the
provisioner's, which a stored `driver` names.

Definition of done:
- [x] Migration on D1 and SQLite with an upgrade test that converts every driverless `cloud` row into a placement on its serving host; no row left without a host. Progress: `access` is dropped by `0034_drop_workspace_access.sql` on D1 and by `dropWorkspaceAccessMode` in the SQLite authority store, each with an upgrade test that seeds pre-drop rows, applies the drop and asserts the column is gone and every row's `backing` and directory survive. The daemon's own inventory needed no migration: its only placements are this machine's worktrees and the provisioner's sandboxes, and `ensureWorkspace` now refuses a `cloud` row that names no driver, so the driverless row cannot be created. No composition ever wrote `host_enrollment_id` into that store, so the field, the injected host reader and `migrateWorkspacePlacements()` were removed rather than wired up.
- [x] `workspaceBacking` derives `kind` from placement; a test pins `cloud-vm` vs `hosted`; no code path constructs a `cloud` row without a driver any more (grep). Progress: `workspacePlacement()` in `server-core/workspace/store/placement.ts` answers `self` or `provisioner`, and `workspaceBacking` returns `local-worktree` or `cloud-vm` — `UserHostedBacking` is gone. A source scan over every production `ensureWorkspace` cloud write fails on a conditional driver spread. `allocateOriginCloudWorkspace` refuses with `placement_unsupported` when the composition declares no driver, and the hosted Worker composition now declares one from the injected driver, which is what makes a Tasks cloud root allocatable there at all.
- [x] Catalog, relay target resolution, `activeWorkspaceHost` and mint read the placement; the readiness table stays the one serving predicate. Progress: the public workspace JSON carries `placement: { host_enrollment_id, directory }` on D1 (assignment→enrollment join in `workspaceAccessSql`) and on SQLite (`assignedHostEnrollmentIds`), on the single-workspace read and in the catalog list on both, and no longer carries `access`. Every server-side reader of `access` now reads `backing`: the six filters in `host-access-authority.ts`, the SQLite twin, the relay-target resolvers, `runtime-target.ts`, the two connection mints, the hosted documents relay, `session/list.ts`, the hosted shell and workspace routes, and the Agent Plugins D1 store's own SQL.
- [x] `registerUserHostedWorkspace` becomes "publish placement" with the same POST-plus-beat shape; the app-side auto-publish driver is unchanged except for the name. Progress: `publishWorkspacePlacement` / `withdrawWorkspacePlacement` in `share-workspace.ts`, same port-first path and same `POST`/`DELETE /api/workspace/:id/host-assignment`; the two stale e2e comments naming the old symbol were corrected.

### Slice 4 — App: one placement resolver, kind literals deleted

Introduce `placementWire(placement, self)` in one module under
`platform/runtime`, where `self` is this machine's enrollment id (or
"unenrolled loopback"). Every consumer of `workspaceKind`,
`isRelayBackedWorkspaceKind`, `isLocalPersonalScope` and the string
literals calls it. The event target selection opens `wr/events` over the
wire the resolver names; the loopback aggregate from the two-event-streams
follow-up, if landed, keys on the same answer.

Definition of done:
- [ ] `grep -rn '"user-hosted"\|workspaceKind\|isRelayBackedWorkspaceKind' packages/claxedo-app/src` outside the resolver and its tests returns zero; the literal count is recorded before and after. Progress:
- [ ] Resolver tests: enrolled desktop + own placement → loopback; enrolled desktop + other host → relay; unenrolled desktop → loopback for own directories only; web → relay always; a placement whose host is unknown → no stream, no request, a visible "machine offline" state. Progress:
- [ ] Event targets, runtime request path and placement code have one call site each into the resolver; the three copies of the branch are gone. Progress:
- [ ] Tier R: `real-harness-local`, `real-user-hosted-relay`, `real-desktop-signed-cloud` green; e2e mock routes bound to the slice 3 contract. Progress:

### Slice 5 — Product surface: one "This machine"

The rail, the remote access panel and onboarding show machines by the name
derived on the machine (Q5), for example "Yashvardhan's Mac", identical on
the desktop and on the web, with a rename control in Settings → Machines. "Add a machine" is one instruction, the
`claxedo connect` one-liner, shown only when the machine in question is
not running the desktop app. No screen uses the words "user-hosted" or
"local" as a workspace type.

Definition of done:
- [ ] Copy audit: zero occurrences of "user-hosted" in `claxedo-app/src` i18n and components; "local" survives only where it means "not published". Progress:
- [ ] Playwright: signed desktop with remote access on shows its machine under the derived name with its workspaces; the same account on the web shows the same machine and the same workspaces, with the relay wire; a rename on the desktop shows on the web; adding a connect host from the panel lists it under its display name. Progress:
- [ ] Onboarding's remote-access surface explains publication as "share this machine's workspaces with your account", with the inventory-privacy consequence stated on the switch. Progress:

### Slice 2c — Share levels: follow and send

A session share carries a level, `follow` or `send`, on the control plane's
share grant (D1 and SQLite), in the Relay Host Token's per-session claims,
and in the runtime's turn admission: a grantee at `follow` may read and
stream the session; at `send` may also prompt it and answer its permission
and question prompts. The share dialog (slice 5) offers both and shows the
disclosure from Q6 before a `send` grant is confirmed.

Definition of done:
- [ ] Grant level persisted on both adapters with an upgrade test; `session.share.changed` carries it; revocation and downgrade end the extra capability within the renewal cadence. Progress:
- [ ] Runtime turn admission and permission/question answers refuse a `follow` grantee and admit a `send` grantee, on the daemon probe spec and on a connect host. Progress:
- [ ] Share dialog offers the two levels; the disclosure text is shown and must be acknowledged for `send`; Playwright covers grant, downgrade and revoke. Progress:

### Slice 6 — Provider configuration reaches a host (carried from 09-14)

A host, desktop or connect, receives provider credentials from the control
plane over the tunnel under a host-management grant, so agent turns on a
connect host do not depend on the machine's own harness logins. Sequenced
last because slices 1–2 give the desktop the machine principal this needs.

Definition of done:
- [ ] Host-management grant defined at the control plane; only the owner can push provider config to a host; pushed config is stored encrypted at rest on the host with the machine key. Progress:
- [ ] Tier R connect spec 5b un-fixme'd: a session on a connect host runs a turn with a provider configured only in the control plane. Progress:

## 4. Cross-cutting acceptance (run at the end of slices 2, 4, 5)

- [ ] Signed-out desktop: every flow works with no network; no request leaves the machine (proxy capture). Progress:
- [ ] Signed desktop, remote access off: nothing is published; the web sees no "This machine". Progress:
- [ ] Signed desktop, remote access on: the web opens a workspace on it through the relay; the desktop opens the same workspace over loopback; both see the same session list within one notice. Progress:
- [ ] Teammate with a session share but no workspace access: session-scoped stream only, on every wire; revocation ends it within the renewal cadence. Progress:
- [ ] Ratchets green with measured ceilings; per-package typecheck; oxlint zero on the diff; all pre-existing reds listed with their owners. Progress:

## 5. Product decisions to take before slice 2

Decided 2026-09-19 with the recommended answer in each case, on the
user's instruction to execute the plan end to end; any of them can be
reversed before slice 5 ships.


- **Q1. Inventory publication.** DECIDED: machine-level switch stays. Publication sends directory paths and repo names to the control plane; the switch copy must say so.
- **Q2. Pre-existing local sessions.** When remote access is turned on, sessions created before are either registered lazily with the owner as creator on first remote access, or stay desktop-only. DECIDED: lazy registration with the owner as creator on first remote access; nothing becomes visible to others without a share.
- **Q3. Self-hosted server with auth on localhost.** Today treated as signed web. Under the resolver it is "host is not me" unless the server declares its enrollment as this machine's. DECIDED: keep signed-web behaviour; no special case.
- **Q4. The word for the user's other machines.** DECIDED: "machine" everywhere, "host" only in code.
- **Q5. Machine naming.** DECIDED 2026-09-19 (user): a machine is shown by a name derived on the machine itself from the account name and the computer name, for example "Yashvardhan's Mac", identical on desktop, web and every other device. "This machine" is never a label; slice 5 renders the name and offers a rename.
- **Q6. Share levels.** DECIDED 2026-09-19 (user): a session share has two levels, follow (read, live) and send messages (prompt the agent, answer its prompts). Granting send shows a disclosure before confirmation: the agent runs with the workspace machine's files, so a sender can have it read anything on that machine, including other sessions' transcripts in the workspace; sharing works best for sessions on a per-session cloud environment, and sessions from a workspace on a machine holding anything a teammate must not reach should not be shared. The session authority's `write` action admits a share grantee only at the send level; slice 5 owns the dialog, slice 2c (new) owns the grant level on the control plane and the runtime's turn admission.

## 6. Risks

- Slice 2 touches the three authorization sites the runtime shares with connect hosts and cloud VMs; a regression there is a privacy hole. Every change ships with the §14.1 probe as a live test, and the slice is reviewed adversarially before merge.
- Slice 3 rewrites rows other products read (catalog, relay, mint). There is no compatibility bridge, so the control-plane change and the app's reader change (slice 4) ship in the same branch and are proven together by the grep for `access` / `user-hosted` readers.
- Slice 4 is a wide mechanical change; it is the slice where an agent will "simplify" a branch it does not understand. Ownership is by directory, the resolver is written first and reviewed alone, and consumers are migrated by lanes that may only replace a branch with a resolver call, never restructure around it.
- The loopback aggregate stream (two-event-streams follow-up) and slice 4 both touch event target selection. Land one before the other; do not run them in parallel on one tree.

## 7. Execution: lanes, ownership, parallel agents

Cut a worktree per slice from `dev`. Inside a slice, partition by directory
and give each agent lane an ownership map; commits are path-scoped
(`git commit -- <paths>`), never `git add -A`, never stash on a shared
tree. Reviews are adversarial and read the diff, not the agent's summary.

- Slice 1: one lane (desktop main + connector child), one reviewer.
- Slice 2: two lanes — daemon ingress + policy (local-server, workspace-runtime routes), and tests/probes (Tier R + the §14.1 probe as a spec); one reviewer per lane, then one whole-slice reviewer.
- Slice 3: three lanes in parallel — D1 migration + routes, SQLite twin, app-side publish rename; one reviewer.
- Slice 4: resolver lane first, alone, reviewed; then four consumer lanes in parallel by directory (`app/integrations`, `platform/runtime`, `features/workspaces`, `features/session` + rail); one whole-slice reviewer with the grep as the entry gate.
- Slice 5: one copy lane, one Playwright lane.
- Slice 6: one control-plane lane, one host lane, sequenced.

Run `bun run test:architecture-ratchets` before every commit that adds or
redirects a production import; when a ceiling moves, name the owner in the
adjacent comment and raise to the measured value only.

## 8. Definition of done for the whole plan

- [ ] Slices 1–5 merged to `dev` with their per-slice checklists complete and their commands and counts recorded. Progress:
- [ ] Slice 6 either merged or explicitly deferred with the unmet requirement, evidence, blocker and owner named. Progress:
- [ ] Q1–Q4 answered in this document with the date. Progress:
- [ ] `2026-09-14-003` P7 marked superseded by slices 1–2 here. Progress:
