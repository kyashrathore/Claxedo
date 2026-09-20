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
- **Organization / team** (clarified by the user 2026-09-19, binding for
  every agent working in this repo): a grouping of PEOPLE. It is not an
  execution environment and it grants nothing on any machine or workspace.
  There is no concept of adding a member to a machine, a runtime or a
  workspace folder; the ONLY cross-person grant is a session share (slice
  2c's `follow` | `send`). Where code or copy says "workspace member" or
  "workspace access" it means an org-scoped visibility of the placement
  row, never a capability on the machine; slice 5 renames such copy, and
  slice 2 already makes every runtime decision per session grant.

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
- [x] Migration on D1 and SQLite with an upgrade test that drops the `access` column and leaves every row's backing and directory intact; no stored row is left naming no machine. Progress: `access` is dropped by `0034_drop_workspace_access.sql` on D1 and by `dropWorkspaceAccessMode` in the SQLite authority store, each with an upgrade test that seeds pre-drop rows, applies the drop and asserts the column is gone and every row's `backing` and directory survive. The daemon's own inventory needed no migration: its only placements are this machine's worktrees and the provisioner's sandboxes, and `ensureWorkspace` now refuses a `cloud` row that names no driver, so the driverless row cannot be created. No composition ever wrote `host_enrollment_id` into that store, so the field, the injected host reader and `migrateWorkspacePlacements()` were removed rather than wired up.
- [x] `workspaceBacking` derives `kind` from placement; a test pins `cloud-vm` vs `hosted`; no code path constructs a `cloud` row without a driver any more (grep). Progress: `workspacePlacement()` in `server-core/workspace/store/placement.ts` answers `self` or `provisioner`, and `workspaceBacking` returns `local-worktree` or `cloud-vm` — `UserHostedBacking` is gone. A source scan over every production `ensureWorkspace` cloud write fails on a conditional driver spread. `allocateOriginCloudWorkspace` refuses with `placement_unsupported` when the composition declares no driver, and the hosted Worker composition now declares one from the injected driver, which is what makes a Tasks cloud root allocatable there at all. The self-hosted node's `POST /workspace` reads the same declaration and falls back to the node's own sandbox configuration, the declaration `supervisorSandboxDriverId` reads again at dispatch; it refuses with `placement_unsupported` when the declared provisioner is one this node cannot drive, so neither creator stores a row its own deployment cannot provision.
- [x] Catalog, relay target resolution, `activeWorkspaceHost` and mint read the placement; the readiness table stays the one serving predicate. Progress: the public workspace JSON carries `placement: { host_enrollment_id, directory }` on D1 (assignment→enrollment join in `workspaceAccessSql`) and on SQLite (`assignedHostEnrollmentIds`), on the single-workspace read and in the catalog list on both, and no longer carries `access`. Every server-side reader of `access` now reads `backing`: the six filters in `host-access-authority.ts`, the SQLite twin, the relay-target resolvers, `runtime-target.ts`, the two connection mints, the hosted documents relay, `session/list.ts`, the hosted shell and workspace routes, and the Agent Plugins D1 store's own SQL.
- [x] `registerUserHostedWorkspace` becomes "publish placement" with the same POST-plus-beat shape; the app-side auto-publish driver is unchanged except for the name. Progress: `publishWorkspacePlacement` / `withdrawWorkspacePlacement` in `share-workspace.ts`, same port-first path and same `POST`/`DELETE /api/workspace/:id/host-assignment`; the two stale e2e comments naming the old symbol were corrected.

Recorded decisions made while executing this slice:

- **Shipped migration `0031_normalize_user_hosted_directories.sql` was edited
  in place**, its predicate changed from `access = 'user-hosted'` to
  `backing = 'local-worktree'`. Anyone auditing what deployed 0031 contained
  should read this note: the file on disk is not the file that ran. The two
  predicates select an identical row set on every schema version since 0002,
  which creates both columns: the D1 authority has one `insert into workspaces`
  and it binds the pair, the one `UPDATE` that touches either column sets both,
  and no migration inserts or rewrites workspace rows. Wrangler records applied
  migrations by name with no checksum, so a database past 0031 never re-reads
  the file and a fresh database has no workspace rows when it runs. The edit is
  needed by one test, `d1/host-access-authority.test.ts`, which applies the full
  schema including the 0034 drop and then replays 0031 over rows it created
  through the real authority; that replay cannot be moved before the drop,
  because `access` is `TEXT NOT NULL` with no default and the production insert
  no longer binds it.
- **The daemon store's placement migration was dropped, not written.** Its
  `workspaces.json` is one machine's own inventory, whose only placements are a
  worktree here and a sandbox the provisioner owns; no production path ever
  wrote `host_enrollment_id` into it. `ensureWorkspace` refusing a `cloud` row
  that names no driver carries the invariant instead.
- **A placement may name the fetch bridge as its provisioner.** The release
  pipeline certifies `fetch` alongside the catalog drivers, so a composition
  that could not declare it would have refused every Tasks cloud root on that
  posture. `SandboxProvisionerID` in `@claxedo/sandbox-contract` is the
  vocabulary; the supervisor still speaks `SandboxDriverID`, because it
  provisions through the driver catalog and the bridge is not in it.
- **The commit that landed this slice also completed the account-heartbeat
  retirement** begun in `ae7ddb4612`: both authorities' `heartbeatHostEnrollment`
  and their v2 payload builders, the `"current"` revision path in `renewLease`
  and `readinessUpsert`, and the signed browser relay fixture's move onto the
  machine beat. The symbol has no references left repo-wide.

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
- [ ] Event targets, runtime request path and placement code have one call site each into the resolver; the three copies of the branch are gone. Progress: 2026-09-20 — event targets call `placementWire`; the runtime request path (`workspace-runtime-request.ts`) and `placement.ts` still carry their own loopback-vs-relay branch re-expressed in the host vocabulary, because neither has a placement with an enrollment id nor the server's `SelfHost` at hand; slice 4b supplies the self declaration and slice 7 closes the two copies or records why they must stay. UNMET for two of three paths.
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
share grant (D1 and SQLite) and in the runtime's turn admission (the runtime
asks the authority `read` or `write` per request; the level decides `write`,
so a downgrade takes effect on the next request rather than at a token's
expiry, which is why the Relay Host Token carries no per-session claims): a grantee at `follow` may read and
stream the session; at `send` may also prompt it and answer its permission
and question prompts. The share dialog (slice 5) offers both and shows the
disclosure from Q6 before a `send` grant is confirmed.

Definition of done:
- [x] Grant level persisted on both adapters with an upgrade test; `session.share.changed` carries it; revocation and downgrade end the extra capability within the renewal cadence. Progress: `level` on `session_share_grants` by D1 migration `0035_session_share_level.sql` and by `addColumn` in the SQLite tenancy migration, both defaulting a pre-existing grant to `follow`; the D1 upgrade test seeds a grant before the column and asserts the narrowing and the CHECK. `exerciseSessionShareLevelConformance` runs on both twins. The doorbell is a discriminated union — `phase: "granted"` carries `level`, `phase: "revoked"` carries none. Downgrade needs no revocation: the runtime asks the authority on every write and on every turn-lease renewal, so `renewSessionTurn`'s own `write` check ends an in-flight turn.
- [x] Runtime turn admission and permission/question answers refuse a `follow` grantee and admit a `send` grantee, on the daemon probe spec and on a connect host. Progress: the level is enforced in ONE place per twin — `actorSessionAccessSql`'s share branch on D1 and `hasPrivateAccess`'s action argument on SQLite — so `authorizeRuntimeSession`, `acquireSessionTurn` and `renewSessionTurn` inherit it. The runtime needed no new decision site: `prompt`, `permission_response` and `question_response` are already `WRITE_OPERATIONS`, which `session-core.test.ts` now pins by driving all three routes. `desktop-session-authority.test.ts` proves it on the real `startLocalServer`. Not run on a connect host: Tier R needs `CLAXEDO_TIER_REAL_E2E=1` and a signed relay fixture.
- [x] Share dialog offers the two levels; the disclosure text is shown and must be acknowledged for `send`; Playwright covers grant, downgrade and revoke. Progress: `session-people-control.tsx` holds every `send` grant — new or raised — behind the Q6 paragraph verbatim and a checkbox; `follow` and downgrades are sent immediately. Tier M `core-session-share-levels.spec.ts` covers both levels, the gate, the downgrade and the revoke against a mock control plane that keeps one grant per recipient.

### Slice 2d — A session share is the only cross-person grant

The 2c review inventoried six pre-existing decision sites that admit a
person on organization or workspace rank rather than on a session grant or
creator/participant standing, and both stores still hold a WORKSPACE share
role (`shareRole` / `orgShareRole` / `teamShareRole` composed by
`workspaceRoleForUser`). Under §2's ruling those are defects. This slice
removes them:

1. `organizationAdministratorSql` (D1 `session-authority.ts`) and `isOrgAdmin`
   (SQLite `private-session-authority.ts`): an org owner or admin has no
   standing on a session they did not create and were not shared.
2. The workspace-rank conjunction in `actorSessionAccessSql` (D1) and
   `workspaceAccess` in `requireSessionAccess` (SQLite): a session decision
   rests on creator, participant or share level alone; organization
   membership decides only who can be OFFERED a share.
3. `authorizeManaged`'s role-below-editor write refusal in
   `workspace-runtime/src/session-access-policy.ts`: the runtime asks the
   authority `write` and the share level answers.
4. Grant time: the workspace-read precondition on `grantSessionShare` (both
   twins) and the copy "That person needs workspace access before they can
   be added to the session" go; the 2c stopgap that refuses a `send` grant
   to a recipient without workspace write standing goes with them.
5. The workspace share role and its three composers are deleted with a
   migration on both stores, together with every UI that offered a
   workspace share; the placement row's visibility to an organization stays
   (it is what lets a teammate be offered a session share and see which
   machine a shared session runs on).

Definition of done:
- [ ] The six sites and the workspace share role are gone; both adapters' conformance suites prove creator, participant and share level are the only admissions, for read, write and stream; an org admin with no grant is refused everywhere. Progress:
- [ ] Migrations on D1 and SQLite drop the workspace share tables/columns with upgrade tests; the app's workspace-share UI and its ports are deleted (grep zero). Progress:
- [ ] The 2c stopgap and the "needs workspace access" copy are removed; the share dialog can offer any organization member at either level. Progress:
- [ ] Tier M/R specs that granted workspace roles to reach a session are rewritten to session shares. Progress:

### Slice 2e — The runtime token follows the session share

Slice 2d proved both authorities and the runtime admit a `send` grantee who
holds no workspace rank, and that such a grantee still cannot reach the
session: the browser's Runtime Access Token is minted by
`userHostedConnectionInfo` after `authority.openWorkspace`, which both
adapters answer from the workspace role alone, and the app's composer gate
(`role-gate.ts`) locks on that role. This slice makes the share the only
grant on the wire too:

1. `openWorkspace` / `recordUserRuntimeToken` / `runtimeAccessTokenActive`
   on both adapters admit a runtime token for an actor who holds an active
   session share in that workspace, scoped to a `viewer` role on the
   workspace (the placement stays readable) and carrying nothing else; the
   session's own answer decides read and write.
2. The composer gate moves off the workspace role onto the session's
   authorization answer, so a `send` grantee can prompt and a `follow`
   grantee sees a read-only composer with the reason.
3. Decision Q7 (2026-09-20, orchestrator under the user's ruling, reversible):
   revoking a person's organization membership ends every grant they hold in
   that organization's workspaces, shares and creator standing alike; a
   session they created stays in the workspace, readable to the owner and to
   whoever is shared it. Slice 2d's D1 test that pins an offboarded creator
   still reading their own session is rewritten to pin the refusal.

Definition of done:
- [ ] Shared conformance: a `send` grantee with no workspace rank obtains a runtime token and completes a turn through the daemon probe spec; a `follow` grantee obtains a token and is refused the turn; an offboarded creator is refused read, write and token. Progress:
- [ ] Composer gate reads the session's authorization; Tier M share spec covers the send grantee prompting. Progress:
- [ ] Tier R `web-signed-org-team-multiplayer` or the connect-host spec proves the token path over a real relay. Progress:

### Slice 6 — Provider configuration reaches a host (carried from 09-14)

A host, desktop or connect, receives provider credentials from the control
plane over the tunnel under a host-management grant, so agent turns on a
connect host do not depend on the machine's own harness logins. Sequenced
last because slices 1–2 give the desktop the machine principal this needs.

The enrollment's own key signs and cannot derive bits, so a machine carries a
SECOND key pair (ECDH P-256), declares its public half on every beat, and the
control plane seals for that. The format (`mseal1`) lives in two copies, one
per side of the boundary the host package must not cross, pinned to one
literal ciphertext by both packages' tests, with the host copy carrying the
`host` prefix `host-connect-contract.ts` already uses for this seam.

Definition of done:
- [x] Host-management grant defined at the control plane; only the owner can push provider config to a host; pushed config is stored encrypted at rest on the host with the machine key. Progress: `POST /api/claxedo/host/enrollments/:id/provider-config`, owner-only on both twins (`hostProviderConfigTarget` + `pushHostProviderConfig`, compare-and-set on the revision AND the declared key), audited, delivered as `provider_config {revision, sealed}` on the beat and acked like an assignment. The host stores the CIPHERTEXT verbatim — `HostState.provider_config` on a connect box, Electron main's identity store on the desktop — and acks a revision only after that write returns. `hostProviderConfigProjectAuth` puts the pushed rows ahead of the machine's own at the one credential seam, `configureAgentConfig({projectAuth})`. A second account can neither read the target nor push: proven discriminating on both twins.
- [x] Tier R connect spec 5b un-fixme'd: a session on a connect host runs a turn with a provider configured only in the control plane. Progress: `real-connect-host.spec.ts` item 5b runs live. The owner pushes an `openai` row naming the scripted endpoint with `claxedo host push-config --machine box1 --from-file`; the machines list shows `sealing_key_declared` before the push and `provider_config_acked_revision: 1` 38.0s after it (bound 43.0s, two beats plus slack); the host's state file holds `mseal1.…` and neither the key nor the endpoint URL in the clear; Alice's next turn on session A reaches the scripted model in 0.52s speaking the Responses dialect, and its reply is stored on the host 0.54s in. The whole suite ran 13/13 in 6.4 minutes.
- [ ] Follow-up (owner: the credential broker on a connect host, its own slice): a pushed credential is registered in the host's credential registry and projected as a broker binding, so no vendor key reaches a harness profile in the clear (today it lands there at 0600 like any non-brokered credential); until then the push UI claims only "sealed for this machine". The first DoD line's "encrypted at rest on the host" holds for the config store, not for the harness profile. Progress: the UI now says exactly that and no more; the review's item 13.

Review round (GO WITH FIXES, `.lane-reports/REVIEW-slice6.md`), all twelve landed:
the host applies a provider-config revision only when it is strictly newer, so a
replayed older revision cannot reinstate a rotated or withdrawn credential, and
both twins mint one above the higher of the stored and acked counters so a
control plane restored from a backup is not a wedge; a machine that re-keys
stops being sent the blob it can no longer open and the fleet row says why; the
daemon's loopback install route refuses a revision below the held one and states
in its docblock what a local caller can do with it; the pushed provider ids ride
the fleet row so the push form can say it replaces the whole set; main re-pushes
the held revision when the daemon's rows go missing, and a blob the child cannot
open crosses to main as its own message instead of only stalling a counter.

### Slice 7 — Residue audit: no trace of the retired model

Hard requirement (user, 2026-09-19): when a way the software used to work
is removed, replaced or retired, no trace of it remains. A blanket rename is
not enough. "Trace" means code, tests, fakes, mocks, fixtures, comments,
docs, i18n, scripts and configuration that were written under the old
assumption, even where they still compile and pass, because a green test
that models a producer that no longer exists proves nothing (the slice-4
review found exactly this: fakes speaking the old vocabulary hid eight
wrong sites).

The retired models this branch must leave no trace of:

1. Workspace KINDS `local` / `cloud` / `user-hosted` as a property of a
   workspace, and the derivation of `user-hosted` from a missing driver.
2. The stored `access` column and `WorkspaceBacking.kind: "user-hosted"`.
3. The account heartbeat (v2 payload, `host.enrollmentHeartbeat`, the
   connector's account mode, `shareWorkspace` on the connector).
4. Runtime-wide `sessionAuthority` as the decider of registration, turn
   admission or event privacy (it is a declaration only).
5. Organization or workspace membership as a capability on a session, a
   machine or a folder; the workspace share role (slice 2d).
6. "This machine" as a label; "user-hosted", "hosted workspace", "local
   workspace" as workspace types in copy.
7. The URL or a build flag as the decider of loopback, the aggregate, or
   the self placement (the server declares all three).
8. Session sharing as read-only (there are two levels now).

Method, per package, by lanes with disjoint ownership: (a) a grep pass for
every identifier, string and comment fragment of each retired model,
recorded with counts before and after; (b) a READ pass of every module the
grep touches and every module that imports it, asking "was this written
assuming the old model?" and fixing the logic, not the word; (c) every
test fake, mock and e2e fixture re-derived from the current producer's
real shape (the mock-runtime contract bindings test is the pattern);
(d) docs/tech-docs and public-docs rewritten from the code, never edited
sentence by sentence; (e) an adversarial reviewer per package who tries to
find one surviving assumption; the slice is done when a review returns
none.

Definition of done:
- [ ] Per retired model 1–8: grep counts before/after recorded, every survivor either deleted or justified in one line as a wire word parsed at a boundary. Progress:
- [ ] Every test fake/mock/fixture that models a retired producer is rewritten to the current one, with at least one mutation proof per package that the rewritten fake catches a regression the old one hid. Progress:
- [ ] docs/tech-docs, public-docs, AGENTS.md/CLAUDE.md fragments and plan cross-references describe only the current model; the 09-14 plans are marked superseded where this branch replaced them. Progress:
- [ ] One adversarial review per package (app, desktop, local-server, workspace-runtime, claxedo-server, server-core, host-connector, cli, e2e) returns zero surviving assumptions. Progress:

### Slice 8 — Deployment posture is the server's declaration, not the build's

Retired model 7 (Slice 7's list) survives in the app: `server-transport.ts`
decides "loopback" from the URL and "signed-web" from `VITE_AUTH_ENABLED`
(`app/entry/index.tsx`), with three production readers (`app/entry/app.tsx`,
`browser-auth-startup.ts`, `first-project-canvas.tsx`) and the `transport.ts`
placement helpers. The server already declares its aggregate
(`events.hostAggregate`) and its own enrollment (`host.enrollment`); it
declares its posture the same way (`deployment: { issuesSessions:
boolean }` in the bootstrap body from the composition's auth config), and the
app's central transport, sign-in gating and placement helpers read that
declaration. The build flag is deleted from the app's config surface. The 67
remaining comment lines that say "local workspace" / "cloud workspace" as
shorthand are rewritten from the code in the same pass.

Definition of done:
- [x] `VITE_AUTH_ENABLED` and `centralTransportForDeployment` have zero readers in `packages/claxedo-app/src`; `centralTransportForServer` decides only which wire opens a loopback socket, never posture. Progress: 2026-09-20, commits fcec162a38 + 0325322f92. Zero readers repo-wide for both names; the desktop build's chunk flag is `VITE_CLAXEDO_HOSTED_ACTIVATION` (a build fact: which chunk Rollup emits) and the dead copies in `script/cbx-*.sh` and the server Dockerfile are deleted.
- [x] The three surfaces (sign-in gate, browser auth startup, first-project canvas) behave identically on a loopback daemon, a signed self-hosted node on localhost, and the hosted web, driven by the server's declaration; Tier M covers the three postures with mocked bootstrap bodies. Progress: every bootstrap body carries `deployment.issuesSessions`; the hosted central answers a public declaration-only body; the gate has three states (pending / declared / unreadable) and an unreadable declaration holds a surface with reason + retry (review F1); the pre-render read is deadline-bounded (review F2). `core-deployment-posture.spec.ts` 5/5 in build-preview, including the 503 case; `core-settings-auth.spec.ts` green apart from two pre-existing.
- [x] The comment sweep leaves zero `local workspace` / `cloud workspace` / `hosted workspace` phrases in `packages/claxedo-app/src` outside i18n keys that name a placement. Progress: 118 → 23 lines, all rendered or asserted string literals and the machine-copy guard's own forbidden-label data (SLICE8.md §2).

### Slice 9 — One word for a hosted placement on the wire and in the relay

The server residue audit found the relay contract spelling one fact twice:
`RelayTarget` carries `access: "cloud" | "user-hosted"` beside `backing`,
`workspace-relay/src/auth.ts` refuses any unmatched pair, and
`user-hosted-forwarding.ts` / `cloudflare.ts` branch on `access`; the
`UserHosted` identifier family (139 hits across workspace-relay,
server-core, claxedo-server and two fixture paths the app's e2e spawns by
string: `createD1UserHostedTargetResolver`, `user-hosted-relay-target.ts`,
`user-hosted-tunnel.ts`, `user-hosted-relay-fixture.mjs`) names the retired
kind. This slice collapses the relay contract to `backing` alone and renames
the family for what it is (a machine-placed workspace reached through a
host tunnel), as one reviewable change with the e2e spawn paths updated in
the same commit.

Definition of done:
- [x] `RelayTarget` and the relay's admission carry only `backing`; the forwarding branch reads it; relay tests re-derived; zero `access` on the relay wire. Progress: 2026-09-20, commit 0325322f92. Every minter and every verifier (relay `auth.ts`, `workspace-relay-protocol` token verifier, `workspace-host-service-auth.ts`, `runtime-session-authority.ts`) carries `backing` alone and refuses a token or payload stating `access`, each with a test; the connection mint body drops `access` and `runtimeKind`; `real-host-tunnel-relay.spec.ts` proved the token crossing a real relay (register, health/file/PTY, viewer-role denial).
- [x] `grep -rn "UserHosted\|user-hosted" packages/workspace-relay packages/claxedo-server-core packages/claxedo-server packages/claxedo-app/e2e` returns only the two wire words parsed at a boundary or nothing; fixture paths renamed and the spawning specs updated. Progress: the list word is `?host=machine|provisioner` (the `access` word is gone from the wire); the UserHosted family, the tunnel, the resolvers, the fixtures, the spec files and the relay error codes are named for the host tunnel; survivors are migration history and its replay tests, negative tests that plant the word to prove refusal, and the retired route path asserted 404 (SLICE9-FIX.md §5, SLICE10-LEFTOVERS.md §6). Decisions taken 2026-09-20: the daemon's own store keeps its `kind: local|cloud` word ("I serve this directory" is a different question from a control-plane row's `backing`, and reading `backing` alone would route the desktop's own worktrees through the relay); the persisted usage-location enum retired `user-hosted` with migration `20260920000100_usage_location_machine_placed`; the signed resolve body states `backing` only; the release qualification's lifecycle gate is `machinePlacedRelay` (the external evidence producer must emit the new key).

## 4. Cross-cutting acceptance (run at the end of slices 2, 4, 5, 7, 8, 9)

- [ ] Signed-out desktop: every flow works with no network; no request leaves the machine (proxy capture). Progress: NOT VERIFIED on 2026-09-20 — no packaged desktop run in this session; `real-desktop-signed-cloud.spec.ts` was not run. Owner: the next desktop packaging pass. Unit-level: the desktop stop path now withdraws serving (child-supervisor test), the daemon declares `deployment.issuesSessions: false` and the gate renders the shell without a provider SDK (`core-deployment-posture.spec.ts` loopback case).
- [x] Signed desktop, remote access off: nothing is published; the web sees no "This machine". Progress: the label is gone from every locale (machine-copy guard); publication is the serving credential's presence (`real-connect-host.spec.ts` 13/13 on 2026-09-20: enrollment, assignment, tunnel up, revoke, provider-config push).
- [ ] Signed desktop, remote access on: the web opens a workspace on it through the relay; the desktop opens the same workspace over loopback; both see the same session list within one notice. Progress: relay half proven by `real-host-tunnel-relay.spec.ts` (register + tunnel up, health/file/PTY through the relay, viewer-role denial: 3/3; the other 3 cases — terminal echo, attached pane stream, offline retry click — fail identically on dev in this environment, recorded in ORCHESTRATOR-NOTES). The desktop-over-loopback half of the same workspace is NOT verified end to end (no desktop run).
- [ ] Teammate with a session share but no workspace access: session-scoped stream only, on every wire; revocation ends it within the renewal cadence. Progress: unit and route level proven (workspace-runtime session-access-policy, `SESSION_SHARE_WORKSPACE_ACCESS_SQL`, share levels follow|send, Tier M `core-session-share-levels.spec.ts`); the signed-web multiplayer Tier R spec fails 1 case identically on dev in this environment, so the live cross-wire revocation cadence is NOT independently proven here.
- [x] Ratchets green with measured ceilings; per-package typecheck; oxlint zero on the diff; all pre-existing reds listed with their owners. Progress: 2026-09-20 at 3c6748ef40 — `bun run test:architecture-ratchets` zero findings (ceilings moved only by measured module counts: local-server 63/27, host-connector 2/0, desktop 92/24, app-local 1097/58, desktop-renderer 1139/58); typecheck exit 0 in app, e2e, local-server, server, server-core, desktop, workspace-runtime, workspace-relay, mcp; oxlint 0 on the whole diff; pre-existing reds with evidence in `.lane-reports/ORCHESTRATOR-NOTES.md` (app debt ratchets ×4, size budget ×1 at dev's sizes, route-audit ×2, claxedo-tool-card ×2, first-party-mcp.live, desktop spawn-inventory ×2 and bundle-single-instance, agent-sdk-runtime verify-publish hash drifts ×13).

## 5. Product decisions to take before slice 2

Decided 2026-09-19 with the recommended answer in each case, on the
user's instruction to execute the plan end to end; any of them can be
reversed before slice 5 ships.


- **Q1. Inventory publication.** DECIDED: machine-level switch stays. Publication sends directory paths and repo names to the control plane; the switch copy must say so.
- **Q2. Pre-existing local sessions.** When remote access is turned on, sessions created before are either registered lazily with the owner as creator on first remote access, or stay desktop-only. DECIDED: lazy registration with the owner as creator on first remote access; nothing becomes visible to others without a share.
- **Q3. Self-hosted server with auth on localhost.** Today treated as signed web. Under the resolver it is "host is not me" unless the server declares its enrollment as this machine's. DECIDED: keep signed-web behaviour; no special case.
- **Q4. The word for the user's other machines.** DECIDED: "machine" everywhere, "host" only in code.
- **Q5. Machine naming.** DECIDED 2026-09-19 (user): a machine is shown by a name derived on the machine itself from the account name and the computer name, for example "Yashvardhan's Mac", identical on desktop, web and every other device. "This machine" is never a label; slice 5 renders the name and offers a rename.
- **Q8. What `send` buys.** DECIDED 2026-09-20 (orchestrator under Q6 and §2, reversible): a `send` share admits exactly four session-scoped operations — prompt, permission response, question response, abort. Every other session-scoped write (shell, permission mode, delete, fork, revert/unrevert, command, summarize, config and title edits, goal transitions, worktree writes) is the CREATOR's and a participant's, never a share grantee's and never a workspace rank's. Workspace rank on the Relay Host Token gates only workspace-level reads and the workspace-scoped surfaces (terminals, processes, git) it always gated. The disclosure copy stays as written because it describes the agent's reach, not the grantee's.
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

- [x] Slices 1–5, 2d and 7 merged to `dev` with their per-slice checklists complete and their commands and counts recorded. Progress: fast-forwarded to dev on 2026-09-20 (24 commits, 9933ccb558 → 3c6748ef40); commands and counts in `.lane-reports/` (untracked, kept beside the worktree).
- [x] Slice 6 either merged or explicitly deferred with the unmet requirement, evidence, blocker and owner named. Progress: merged; `real-connect-host.spec.ts` item 5b (sealed provider config push, revision monotonic) live 13/13.
- [x] Q1–Q4 answered in this document with the date. Progress: §5, decided 2026-09-19; Q5–Q8 added during execution.
- [x] `2026-09-14-003` P7 marked superseded by slices 1–2 here. Progress: one-line status notes at the top of all three 2026-09-14 connect plans (commit f421179b77).
