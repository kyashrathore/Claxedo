# Single-tenant today, multiplayer-ready

Date: 2026-08-01. Revised after a three-axis subagent review (feasibility,
adversarial security, coherence/scope), all findings code-verified. Every
`file:line` below was verified once; re-cite before implementing — this repo
moves fast and the plan is untracked.

## Goal

Make the current single-player product safe under concurrent use and install
the identity, tenancy, authorization, and event-delivery boundaries required
for multiplayer — without building multiplayer UI. Work ships in five stages:

- **Milestone 0** — lock down the execution/write primitives that currently let
  any workspace-authorized caller read every session's transcript. Exploitable
  today; independent of multiplayer.
- **Milestone 1** — atomic prompt admission and sender-scoped rejection.
- **Milestone 2a** — identity and tenancy foundation (invisible to users).
- **Milestone 2b** — message attribution + author avatars (visible value).
- **Milestone 2c** — private sessions, authorization, revocation, two-user proof.

M0 and M1 ship independently. Multiplayer UI blocks on **2a + 2b**. **2c** blocks
*private* sessions specifically; if the first multiplayer release is
public-within-workspace, 2c can trail. This slicing is an owner decision
(below), reversing the single-milestone framing of the prior draft.

## Owner decisions (recorded verbatim intent)

These are decisions, not design proposals — do not silently re-litigate them.

1. **Sessions become private-by-default in the future**: visible only to their
   creator until the creator tags a teammate as a participant. "Session
   visibility = workspace visibility" is the *interim* policy, not the design.
   Nothing in this plan may foreclose the conjunctive rule.
2. **Onboarding stays unbranched**: no "org or personal?" question at signup.
   Default silently to the personal org; "Create a team" is a home card later
   (matches plan `2026-07-31-001`). Invite links (future) land the user
   directly in the inviter's org. Personal-org resolution stays *implicit* at
   signup — no code path added by this plan introduces a signup-time tenant
   branch.
3. **Never auto-migrate personal workspaces into a team**. Explicit
   per-workspace transfer only (future). Transfer is also a billing event
   (plans are per-org). This plan adds no code path that reassigns an existing
   workspace's `org_id`.
4. **Session privacy protects the transcript, not the working tree**: a private
   session's file edits in a shared workspace remain visible to workspace
   members. State this honestly wherever privacy is described. (Coherent only
   once M0 lands — see the note there.)
5. **Terminology**: user-facing "Team" = code `org`. No code identifier renames
   (`workspaceId` is the relay routing identity across ~44 sites; `org` is
   baked into schema + auth). A glossary maps the two vocabularies, and it
   settles **before** any invite-feature i18n strings land — the locale
   fan-out is real (16 locales + parity test under
   `packages/claxedo-app/src/platform/i18n/`).
6. **No backward compatibility for Claxedo's internal shapes**: no aliases, no
   dual-read paths, no deprecation windows. Legacy dev/staging rows may be
   deleted. The only surviving constraint is mechanical: a schema migration
   must leave every existing row valid, so any column drop/tighten must
   backfill-or-delete in the same migration. "Behavior pinned by test" pins
   single-player *correctness*, not byte-identical legacy shapes. (The OpenCode client contract in Product
   constraints is a *separate* external boundary that IS preserved.)
7. **Creating a project or workspace in a team org requires workspace
   `editor`-or-above** (org owner/admin map to workspace admin; an explicit
   editor grant qualifies). A plain org `member` (→ workspace `viewer`) cannot
   create tenant infrastructure. Note the two role vocabularies are different
   tables: `orgRole` = owner|admin|member; `workspaceRole` =
   viewer|editor|admin|owner.
8. **Participant management is a creator-or-org-admin operation**: the session
   creator, or an org admin, may add/remove participants. A plain participant
   cannot add further participants.

## Product constraints

### OpenCode is the client contract (the one external compatibility boundary)

Claxedo is an OpenCode port. The app-facing HTTP API and event stream consumed
by the current client stay OpenCode-compatible: existing endpoints, standard
fields, event names, and success behavior remain valid; Claxedo-specific data
rides in optional namespaced extensions; adapter differences behind the runtime
do not leak into the client contract.

**Correction (was overstated):** the plan's earlier claim that this is "covered
by contract tests" is ~1/3 true. What exists: the runtime-event *projection* is
genuinely covered (`packages/agent-event-runtime/src/harnesses/acp/golden-compat.test.ts`
frozen golden; `.../projections/opencode-compat/projection.test.ts` 653 lines/24
tests; `packages/schema/test/legacy-event.test.ts`; `event-manifest.test.ts`).
What does **not** exist and must be built: (a) any test asserting the
workspace-runtime session/event HTTP route set matches OpenCode — the ~30
OpenCode-shaped routes in `packages/workspace-runtime/src/routes/session-core.ts`
(`/session`, `/session/:id/message`, `/event`, `/permission`, `/question`) are
in no manifest and no contract test, and M1 rewrites exactly these; (b) any
upstream-compatible-client test against the real runtime
(`sdk-transport-parity.test.ts` wires the SDK to fetch spies and never hits a
server). Also: `packages/workspace-runtime/src/compat-events.typecheck.ts` looks
like a compile-time contract but is `exclude`d by both tsconfigs — dead code
that enforces nothing.

- [ ] A route-inventory contract test for `session-core.ts`'s OpenCode-shaped
      routes, modeled on the working `packages/claxedo-server/src/opencode-compat.find.test.ts:110`
      technique. **Open question for owner: does this gate Milestone 1?**
      (M1 rewrites these routes with no contract guard beneath them.) Progress:
- [ ] `compat-events.typecheck.ts` re-included in a typecheck project (one-line
      `exclude` change) so the already-written asset starts earning. Progress:

### Internal state installs the target model directly

No backward compatibility for old internal schemas, legacy rows, token claims,
route composition, or storage shapes (owner decision 6). Dev/staging
tenancy/project/session rows may be discarded. Required columns/indexes install
directly, ordered to keep existing rows valid at every step. **Open question for
owner: does production data exist** (launch appears to have shipped ~2026-07-20
via `deploy-control-plane.yml`)? If so, B-items marked "delete & install" become
"install with a migration."

### Current unsigned behavior stays byte-identical

Unsigned/local use continues to work without team setup. Unsigned user messages
render byte-identically to today (the existing generic user icon). Signed-in
messages gain author attribution and render the author's avatar. **Note
(security):** "unsigned" is anonymous in the UI projection only — for
*authorization*, unsigned currently means *skip*, not *anonymous actor*
(`routes/session-meta.ts:60` returns inside `authorizeRead` when `!auth`;
control-plane routes short-circuit to `projectionStore` on loopback). See M2c/B5.

## Target model

Two axes meet at authorization:

- **People axis:** Team (code: `org`) → members and roles → invites.
  Verbs: invite / join / leave.
- **Code axis:** Project (repository) → Workspace (checkout + execution
  location) → Session (agent run). Verbs: create / open / delete. Projects are
  created implicitly per repo per org by workspace open — no user-facing project
  ceremony, by design (`project_memberships` already feeds `workspaceRoleForUser`
  as the fine-grained knob, wired but unexposed).

Every workspace belongs to exactly one org and one project. A personal org
(`kind:"personal"`, no linked team org) is the default tenant for solo use
outside a team — deliberate: uniform tenancy invariant + no per-org billing for
solo users.

### Resource identities

- `org_id` required on tenant-owned rows.
- `project_id` a globally unique opaque identifier. **Hazard (B2):** it has
  three types across tables today — `v.optional(v.string())` (`schema.ts:207,230`),
  `v.id("projects")` (`:251,337`), bare `v.string()` (`:940,1441`). Unifying is a
  typed↔string reconciliation, not a nullability flip.
- `(org_id, repo_key)` identifies repo reuse within a team. **`repo_key` exists
  in neither authority schema today** (only the local workspace store,
  `workspace-store.ts:26`), and **neither authority declares a unique constraint
  for it** — so uniqueness is a mutation-level invariant + test, NOT "the
  database enforces" (prior wording was wrong).
- `workspace_id` remains the execution/relay-routing identity.
- `actor_id` identifies a row in the existing `users` registry;
  `users.kind` (`human`|`agent`) **already exists in the authority store**
  (`workspace-authority-store.ts:28`, NOT NULL).

### Access model

Workspace authority and session authority are conjunctive:

```text
may access private session
  = has required workspace authority
  AND is the session creator or a tagged participant
```

Workspace-role grants combine additively and max-wins; the creator/participant
gate is a *second, conjunctive* filter. The transcript boundary includes
session metadata, messages, tools, questions, permissions, checkpoints, and
live/replayed session events — **and is defined by content, not route-name
prefix** (see M2c/B7: session-derived content leaks through several
non-"session" surfaces). Files in a shared workspace remain governed by
workspace access.

## Milestone 0 — lock down execution/write primitives (live security bug)

**This is exploitable today, single-tenant or not, and it moots the entire
private-session model**: any workspace-authorized caller — down to `viewer` —
can obtain arbitrary host execution and read every session's transcript
directly from the global store (`~/.local/share/opencode/opencode.db`, outside
the workspace file jail). Owner decision 4 ("transcript private, working tree
shared") is not coherent until this lands.

Verified primitives:
- `POST /api/wr/process` (`routes/process.ts:111`) takes arbitrary
  `command`/`args`/`cwd`/`env`; cwd resolved with plain `path.resolve`, **never**
  through the jail (`managed-processes/manager.ts:1011`); **no role gate**;
  config persisted to `.workspace-runtime/processes.jsonc`. Output exfiltrates
  via `GET /api/wr/process/logs`.
- `POST /api/wr/session-env/exec` (`routes/session-env.ts:277`) = `spawn(shell:true)`.
- `POST /api/wr/pty` (`routes/pty.ts:51`) jails cwd but takes arbitrary argv.
- `POST /api/wr/git/commit` (`workspace-files/git-source.ts:117`) — unguarded
  in-workspace write (a second way to plant the persisted process config).
- Relay viewer gate is bypassable: `//api/wr/pty` (doubled slash) defeats the
  `^/api/wr/pty` denial regex (`workspace-relay/src/server.ts:506` vs the
  path-strip at `:499-503`); runtime `pty.ts:43` backstops it.

- [ ] `/process`, `/session-env/exec`, `/pty` resolve every path (including
      `cwd`) through `resolveWorkspacePath`, and argv/command cannot smuggle an
      absolute path that escapes the workspace (test: `cwd` and argv pointing at
      `~/.local/share/opencode` are rejected). Progress:
- [ ] These execution/write primitives + `/git/commit` are role-gated: `viewer`
      is denied; the gate lives in code the relay verb-shape cannot substitute
      for (test: viewer token → 403 on each). Progress:
- [ ] The relay viewer path gate normalizes the path before matching and
      decides on the same string it forwards; `//api/wr/pty` and
      `/%2Fapi/wr/pty` are denied for viewers (test both). Progress:
- [ ] `GET /worktrees/:sessionId` and `store.getWorktree` are scoped by
      `workspace_id` (`store.ts:844` leaks other workspaces' absolute paths
      today). Progress:

## Milestone 1 — atomic prompt admission

### A1. Concurrency: one atomic admission owner (re-scoped)

**Re-scoped after review.** The prior framing ("delete the direct-adapter
branch") was mis-sized: the branch is already near-dead — both production sites
wire `resolveRuntime` (`workspace/runtime.ts:1745`, `central-session-runtime.ts:463`)
and `runtimeForSession` (`runtime.ts:1113-1143`) never returns `undefined`, so
deleting `runSessionPromptTurn` is bookkeeping. The **real work** is that the
atomic admission lease does not exist anywhere: `turns.start`
(`agent-sdk-runtime/src/runtime.ts:392-425`) calls `store.startTurn`
unconditionally and the memory store overwrites `activeTurn` with no occupancy
check (`stores/memory.ts:194-200`). The only busy check today is adapter-local
and defensive (`harnesses/acp/index.ts:811`).

Additional facts the inventory must absorb: `permissionMode` has **no field** in
`AgentRuntimeTurnStartInput` (`runtime.ts:98-110`) and is applied by mutating
harness state *before* admission (`session-core.ts:669,884`); `prompt_async` has
a *second* admission-shaped gate, `promptAdmissions` (`session-core.ts:481`),
idempotency-keyed by `messageID` (returns 204) — distinct from concurrency;
two managed prompt paths sit outside AgentRuntime — the Session V2 wildcard
proxy (`workspace/runtime.ts:1739-1741`) and the vendored engine
(`packages/opencode/.../handlers/session.ts:365`).

- [ ] A single per-session admission lease (acquire → run → release) is the sole
      concurrency authority, acquired atomically before any session state
      (permissions, messages, placeholders, active-turn) changes. Release is
      defined for normal completion, abort, adapter rejection, thrown error, and
      detached `prompt_async`. Test proves double admission impossible across
      retries/aborts, injected at the route layer (not just the harness).
      Progress:
- [ ] `permissionMode` becomes a `turns.start` input threaded to the adapter,
      preserving the documented best-effort/swallow semantics
      (`session-core.ts:173-198`); it is no longer applied by pre-admission
      state mutation. Progress:
- [ ] Inventory covers `promptAdmissions` (idempotency, distinct from the lease)
      and the three non-AgentRuntime prompt paths. The "one observable admission
      owner" claim is scoped explicitly to Claxedo-managed routes; Session V2
      proxy + vendored engine are named as out-of-scope for the lease. Progress:
- [ ] Checkpoint-freeze 423 (`server.ts:497-512`, GET/HEAD/OPTIONS-exempt)
      ordering vs admission is stated (a 423 may preempt the lease). Progress:

### A2. Return collision errors only to the sender

- [ ] Concurrent-prompt rejection returns HTTP `409` from both
      `POST /session/:id/message` and `/prompt_async` with a stable
      machine-readable Claxedo code. **`409` is already used** for
      `unsupported_operation` (`session-core.ts:361`) — the app must
      disambiguate by error code (pinned by test). Progress:
- [ ] A rejected request's `permissionMode` is **discarded and never
      observable** on the in-flight turn or shared session state (closes the
      A1↔A2 seam explicitly). Progress:
- [ ] Success responses keep OpenCode-compatible behavior, including empty `204`
      for `prompt_async`. Progress:
- [ ] The app parses the structured collision response, rolls back only the
      rejected optimistic message, restores composer input, keeps session status
      intact, and does **not** auto-retry on `409` (bounds the collision loop;
      interacts with the existing `x-claxedo-idempotency-retry` path,
      `session-core.ts:892`). Progress:
- [ ] Admission rejection is not published as `session.error`; non-sending
      subscribers receive no error event. Progress:
- [ ] Two-client concurrency test: exactly one prompt admitted, loser gets
      `409`, winner continues under its original permission mode, both converge
      on one coherent transcript. Progress:

### A3. Verify user-message fan-out before changing publication

**Reproduce-first (diagnosis was partly stale):** `AgentRuntime` already assigns
`userMessageId` and publishes initial user events on the managed path
(`runtime.ts:398-413`); `prompt_async` fan-out has tests. Adding a publisher
blindly risks duplicate user messages.

- [ ] Capture deployed `message` and `prompt_async` behavior with two real
      clients (or one + raw SSE) for the ACP and Pi adapters; record whether the
      receiver sees the user message exactly once, before the first assistant
      delta. Progress:
- [ ] If a gap exists, repair the confirmed path and prove exactly-once fan-out
      + optimistic reconciliation by message id. If none, close with linked
      evidence. Progress:

### Milestone 1 acceptance

- [ ] Phase A behavior tests green for `message` and `prompt_async`. Progress:
- [ ] Admission has one observable owner (`AgentRuntime`) across Claxedo-managed
      routes. Progress:
- [ ] OpenCode-compatible app happy path green (name the spec lane, not
      "familiar"). Progress:

## Milestone 2a — identity and tenancy foundation

Invisible to users; the prerequisite everything else needs.

### B1. Make tenancy explicit at every creation boundary + build team creation

**There is no first-party "create team" mutation today.** Personal-org creation
is *triplicated* — `personalOrgForUser`, `ensureOwnerOrg` (`workspaces.ts:29`),
and `ensurePersonalOrg` (`billing.ts:276`, deliberately duplicated to dodge an
orgs↔billing import cycle). None set seats. So "team creation verifies
membership" is net-new, not a check added to existing code.

Workspace-insert inventory: the control-plane workspace mutations
(`createCloud`, `registerLocalForSharing`); the local-host-link
`register`/`registerForService` pair (the challenge-verified path inserts an
**org-less** workspace — the exact shape B1 forbids); SQLite
`registerLocalHostLink` (`workspace-authority.ts:688-691`, also org-less); the
local workspace store.

- [ ] A first-party team-creation mutation exists (creates a team org + owner
      membership). **Open question for owner: does it become
      the add-time seat choke point** `enforceSeatCapacity` (`billing.ts:367`,
      comment `:355`) was written for, and does it populate `seats_licensed`?
      (Launch-free posture likely: populate, don't enforce.) Progress:
- [ ] A source-inventory test covers every workspace insert and fails when a new
      path omits tenancy. It is **AST/grep-based over insert call sites** (not
      helper-keyed — the org-creation triplication would otherwise hide two
      sites); the three org-creation copies are named fixtures so a fourth turns
      it red. Progress:
- [ ] `org_id` and `project_id` are assigned at first write; local-host
      registration (both authority adapters) has no intermediate org-less row. A
      one-shot backfill adopts existing org-less rows into their owner's
      personal org; then `org_id` becomes required (backfill in the same
      migration per owner decision 6). Progress:
- [ ] Solo creation resolves to the caller's personal org, implicitly (no
      signup branch, owner decision 2). Team creation verifies membership and
      requires **workspace editor-or-above** (owner decision 7): org member →
      viewer → typed authz error, no rows, no infrastructure provisioning
      (test). Progress:
- [ ] No code path reassigns an existing workspace's `org_id` (owner decision 3,
      enforced by test). Progress:

### B2. Install the project identity contract

- [ ] Projects use a globally unique opaque `project_id`, reconciled to one type
      across all tables (the string/`v.id`/bare-string split above). Progress:
- [ ] Projects require `org_id` and a canonical `repo_key`; `(org_id, repo_key)`
      uniqueness is a mutation-level invariant + test (NOT a DB constraint —
      neither authority declares one; SQLite has zero unique indexes today).
      Progress:
- [ ] Opening a second workspace for the same repo in one org reuses the
      project; the same repo in two orgs creates two isolated projects (test
      both). Progress:
- [ ] Every `projectByPublicId`/`by_project_id` consumer (7 files, incl. both
      SQLite authority files) uses tenant context where lookup/authorization
      needs it. Progress:
- [ ] `repo_key` derivation is deterministic, with the four cases as separate
      assertions: normal clone, worktree, no-remote repo, distinct orgs. Progress:

### B3. Carry signed actor identity through authority tokens

RAT carries `sub/org_id/workspace_id/host_id/role` today
(`workspace-relay/src/auth.ts:19-30`); no actor. **Naming fix:** there are three
tokens — RAT, RHT (relay→runtime, minted in `workspace-relay/src/auth.ts:305`),
and the Host **Tunnel** Token (minted by the signer the prior draft mislabeled
"RHT" at `runtime-access-token.ts:229`). RAT + RHT need actors; HTT is
host-scoped and does not.

- [ ] The `users` registry is the only actor registry (no parallel principals
      table). Progress:
- [ ] RAT + RHT signing/validation/types require `actor_id` + `actor_kind` for
      signed managed access; the control plane resolves upstream identity to the
      actor before minting; runtime code never reconstructs identity from
      issuer/subject; client bodies cannot assert the actor. Progress:
- [ ] **In-flight-state migration handled** (not a schema install): requiring
      `actor_id` 401s every live RAT (15–60 min TTL). Land accept-optional →
      mint-with → require. `actor_id`/`actor_kind` join `relayHostTokenCacheKey`
      (`server.ts:537-553`) or a cached claim serves one user's actor on
      another's request (test the cache-key isolation). Progress:
- [ ] Interactive, channel-originated (`channel_identities`), and service paths
      each resolve an explicit human/agent actor before minting. Progress:
- [ ] Runtime session routes read verified actor claims and pass them to
      `turns.start`. Unsigned/local stays anonymous *in the UI projection only*.
      Progress:

### B8-partial (schema for 2a)

- [ ] Legacy camelCase `projects` columns retired: `externalId`,
      `organizationId` (a `v.string()`, so `organizationId`→`org_id` is a
      string→`v.id("orgs")` conversion needing per-row org resolution — **not** a
      rename), `name`, `repoUrl`, `createdAt`, `updatedAt` (`schema.ts:236-241`).
      Backfill-or-delete in the same push. Progress:
- [ ] The D1 and SQLite authority adapters express the same required tenancy
      identities/indexes. Progress:

## Milestone 2b — attribution

Depends only on B3's claims. Ships visible value; multiplayer UI blocks here.

### B4. Persist and project message attribution

Attribution is recorded only after admission succeeds. `session_history.created_by_user_id`
exists but is **written and never read** (`sessions.ts:111,191`) and is
**unindexed** — it becomes the creator root for M2c and needs an index.

- [ ] New signed-in user messages persist `author_actor_id` from verified
      runtime claims only. `session_messages` has no author field today; add it.
      Progress:
- [ ] Session-creation paths populate `created_by_user_id` on every path
      (runtime, central, channel-originated), and add the index it lacks.
      Progress:
- [ ] Mirror/storage paths validate the actor belongs to the authority serving
      the workspace; attribution preserved in both authority adapters.
      Progress:
- [ ] OpenCode event names/fields unchanged; a signed-in user message may carry
      an optional namespaced projection:

      ```json
      { "type": "message.updated",
        "properties": { "info": { "id": "msg_123", "role": "user",
          "claxedo": { "author": { "id": "user_public_123", "name": "Yash",
            "avatarUrl": "https://example.invalid/avatar", "kind": "human" } } } } }
      ```

      Progress:
- [ ] The projection is display-safe (public id + name, never internal authority
      id or raw subject); author identifiers follow the org purge/deletion
      cascade. Progress:
- [ ] App renders the author's avatar on their message; another participant's
      message renders theirs; fallback initials → generic icon. Unsigned
      messages render byte-identically to today. Progress:
- [ ] Contract tests: upstream-compatible clients ignore the extension; the
      Claxedo app consumes it. Progress:

## Milestone 2c — private sessions and authorization

The policy object, revocation, identity-aware delivery, and the two-user proof.
Can trail 2a/2b if the first multiplayer release is public-within-workspace.

### B5. Require `SessionAccessPolicy` (greenfield — zero occurrences today)

`SessionAccessPolicy` does not exist anywhere; `authorizeSessionRead`
(`authority.ts:193`) is the closest analog and is **read-only** (no
`authorizeSessionWrite`) and scoped by workspace role, not creator/participant.
The route seam exists but is dead: `beforeSessionOperation`
(`session-core.ts:151,422-429`) is threaded through ~15 routes yet **no
production caller supplies it** (`workspace/runtime.ts:1743`,
`central-session-runtime.ts:461` omit it). Workspace-runtime has **no
session-scoped authorization at all today** — a blanket workspace-scoped
middleware (`server.ts:474-497`), one role check in the whole surface
(`pty.ts:43`). B5 introduces the first per-session boundary.

- [ ] `SessionAccessPolicy` is a required dependency of managed session route
      composition — a managed route cannot mount without it. It receives the
      verified actor, workspace authority, session identity, and operation.
      Progress:
- [ ] Operation matrix covers: session create/list/meta-read/meta-write,
      message, prompt, permission-mode + response, questions, tools, abort,
      revert/unrevert, fork, command, checkpoints, delete, legacy session
      routes, and a **prefix-level decision for the Session V2 proxy**
      (`workspace/runtime.ts:1739-1741`, `app.all`, opaque byte-forward — cannot
      be covered by enumerating native routes). Progress:
- [ ] **List/search need a filter, not allow/deny.** `GET /session`,
      `/experimental/session`, `/session/status`, `GET /permission`,
      `GET /question` have no session id — add a `filterSessions`-shaped
      decision distinct from the per-session hook. Progress:
- [ ] **Non-"session" surfaces carrying transcript content are covered** (the
      root-cause finding — boundary by content, not name): `agent.lifecycle`
      bus frames carry verbatim `prompt`/`lastAssistantMessage` (`bus.ts:67-79`;
      also written to the process log); make the hook route POST-only and bring
      the event under policy via its `sessionId`; PTY (`pty.ts`, scrollback +
      16KB `tail` on the bus, `pty/index.ts:757`) enters the matrix with per-PTY
      ownership bound to the creating session; `process.config.changed`
      (command/cwd/env) and `session.lifecycle.info` audited. Progress:
- [ ] Participant model: **creator or org-admin** may add/remove participants
      (owner decision 8); a plain participant cannot. Creator enrolled at
      session creation. New `session_participants` table (shape mirroring
      `workspace_share_grants`, `schema.ts:281-292`), pure EXPAND, with the index
      creator/participant checks require. Progress:
- [ ] The creator/participant predicate lives inside `authorizeReadSession` in
      **both** authority adapters (`sqlite/workspace-authority.ts:816` and its
      D1 counterpart) and its new write counterpart — so an app/CLI path hitting the data layer
      directly cannot bypass it. Progress:
- [ ] **Unsigned/loopback is a policy decision, not a skip.** Define the
      no-actor case on a signed deployment (deny), enforced where auth is
      *absent* (`session-meta.ts:60`, control-plane loopback short-circuits,
      `proxy.ts:181-189` which mints `role:"owner"` with no actor). Progress:
- [ ] Files stay governed by workspace access (owner decision 4), outside the
      private-transcript policy. Progress:
- [ ] Route-inventory test fails when a managed session surface is added without
      a policy decision. **The current manifest can't anchor this** — 
      `WorkspaceRuntimeRouteManifest` enumerates prefixes, not routes, and omits
      `/session`, `/event`, `/api/session`, `/api/model` (`public-api.test.ts`
      shares the gap). Build the route-level inventory. Progress:

### B6. Write authority + revocation (mostly built; state as a bound)

Downgraded after review — much exists. Full revocation chain works (relay
per-request check `server.ts:967` → resolver → `internal-relay.ts:183` →
`runtimeAccessTokens.active`); the CF adapter tears down open sockets on an
interval (`cloudflare.ts:1193-1230,1607-1665`); `runtime_access_tokens` has
`revoked_at` + `by_workspace_user` index already.

- [ ] Central/control-plane session **mutations** require write authority; reads
      require read (test: viewer reads an allowed session, 403 on mutation).
      Progress:
- [ ] Minted-role preservation pinned: token role equals what `openWorkspace`
      proved (unknown → viewer, never escalates); viewer token denied on every
      mutation verb. (Corrects the prior "read-auth mints write-capable token"
      claim — `relayRole` already preserves the proved role.) Progress:
- [ ] **The one real gap:** membership change revokes tokens.
      `revokeForWorkspaceUser` (`runtimeAccessTokens.ts:129`) has zero callers;
      wire org-kick (`orgs.ts:255`, which today deletes the membership row but
      never revokes RATs) and role-downgrade to it. Progress:
- [ ] **Open-connection teardown gap:** RHT is verified at establishment only
      (documented deliberate ×3). The Bun WS path has no mid-stream check (only
      CF does). Add a connection registry + forced teardown, OR state revocation
      latency as a **bound** (poll interval, capped by `exp`) rather than
      implying instant disconnect. Also: WS origin check ignores custom
      `allowedOrigins` (`bun.ts:450-465`) — fix or document. Progress:
- [ ] The relay verb-shaped viewer gate is the coarse outer wall;
      `SessionAccessPolicy` owns per-operation authorization (in-code note).
      Progress:

### B7. Identity-aware live and replay delivery (the true XL — cite prior art)

**Not "add a predicate."** The SSE replay buffer uses one global monotonic
sequence (`sse.ts:49-50`); per-subscriber filtering punches holes its gap
detector reads as data loss (`:67-87`). There are **eight** replay buffers, and
one stream is *deliberately* unfilterable: `opencode-compat-events.ts:133` is
headed "No per-identity filter — on purpose" because the existing `eventVisibleTo`
predicate would empty it. **Prior art exists in-repo** and B7 must be estimated
as a port of it, not greenfield: `claxedo-server/src/live-sync-room.ts:487`
filters replay per-principal, live fan-out at `:602/:612`, tests at
`routes/events.test.ts:127-247`.

- [ ] SSE/WS subscriptions attach verified `actor_id`/`actor_kind`/org/workspace
      role/connection identity to the subscription record. Progress:
- [ ] Live AND replay-drain AND reconnect AND proxied paths invoke the same
      `SessionAccessPolicy` decision — no shared replay buffer bypasses it. This
      requires the replay ID scheme to change (per-visibility buffers or
      filter-at-write into per-scope buffers), across the eight buffers incl.
      `session-core.ts:482`, `routes/events.ts:14`, `runtime.ts:963`,
      `routes/runtime-events.ts:111`, `claxedo-server/.../events.ts:150`,
      `opencode-compat-events.ts:170`, `live-sync-room.ts:439`. Progress:
- [ ] The deliberately-unfiltered compat stream (`/global/event`,
      `/api/wr/events`) is redesigned — its content IS the transcript, so the
      fix is a content-aware filter, not the existing default-deny predicate.
      Progress:
- [ ] AgentRuntime's in-process fan-out (`runtime.ts:161-167`, filters only on
      sessionId/directory) gains the identity predicate too. Progress:
- [ ] A participant receives an authorized private session's events; a
      workspace member who is not a participant receives none; revocation/
      downgrade stops delivery on already-open connections. Tests use two
      distinct authenticated users across live/replay/reconnect/teardown.
      Progress:

### B8-remainder + B9 (two-user proof)

- [ ] Both authority adapters express the same required session identities/indexes;
      installation ordering documented and verified against a named disposable
      environment. **"Parity" means ENFORCEMENT parity** — both authorities stop
      at workspace `read` today (equally coarse), so participant columns alone
      change nothing; the enforcement is in B5. Progress:
- [ ] **B9 two-user proof** (direct product APIs + real signed tokens; no invite
      UI). Prerequisites, now named on the critical path: the
      `session_participants` table + write verb (B5), the team-creation mutation
      (B1), and test infra that does not exist — no test drives two real signed
      users through the auth stack. Steps: two users in one org + a workspace; prove editor-or-above
      can create it and a plain member cannot; create a private session as A,
      add B as participant (as creator), prove both read/send and a third
      workspace-authorized non-participant is denied metadata/transcript/
      checkpoints/live+replay events; prove distinct authors render correct
      avatars; remove/downgrade B and prove token revocation + stream
      disconnection; run the whole contract through the real app transport and
      verify OpenCode compatibility. Progress:

### Milestone 2c acceptance

- [ ] Every managed workspace/session operation has explicit org/project/actor/
      policy context; managed route composition requires `SessionAccessPolicy`.
      Progress:
- [ ] Private-transcript policy consistent across HTTP, live, replay, reconnect,
      checkpoints — and across the non-"session" content surfaces. Progress:
- [ ] Membership changes revoke tokens and (within the stated bound) active
      connections. Progress:
- [ ] The two-user direct-API proof passes. Progress:

## Documentation deliverables

### `docs/tech-docs/access-model.md`

- [ ] Team=`org` glossary + people/code axes; personal-org creation and explicit
      team creation; global opaque project ids + per-org repo identity; org/
      project/workspace/session/participant authority; the conjunctive
      private-session rule; transcript-vs-working-tree; actor identity in tokens
      + display-safe attribution; live/replay authorization + membership-change
      revocation. Progress:
- [ ] Records the direction (session visibility workspace-derived today, target
      creator-or-participant) and states the glossary settles **before** invite
      i18n strings land (owner decision 5). Progress:
- [ ] Declares non-goals/boundaries: no auto-migration; central event-visibility
      default-deny is intentional for hosted but false for self-host (the
      unfiltered compat handler serves the same frames — see B7); session
      privacy = transcript not working tree; sharing a user-hosted workspace is a
      distinct consent moment; external artifacts (PRs, Slack) governed by those
      systems. Progress:

### Deferred product surfaces

Invite/accept UI; active-team switcher + team-aware nav; personal→team workspace
transfer (incl. billing); participant-management UI; **presence UI (derives from
B7's identity-attached subscription records — do not build a separate presence
channel)**; turn queueing beyond M1's collision rejection; user-facing
project-management ceremony.

## Verification strategy (inherited gates inlined)

`docs/plans/goal.md` does not exist on `dev`; inlining the load-bearing gates:
one reactive data graph; strangler/additive, no flag-day; behavior-asserting
tests (green is a claim, not proof — `packages/claxedo-app/e2e/INVARIANTS.md`
rule #1); make illegal states unrepresentable; per-slice verification.

- Re-cite moving `file:line` before implementing.
- Reproduce observable behavior before changing fan-out (A3).
- Behavior tests before implementation for admission, authorization,
  attribution, event visibility, revocation.
- Replay CI locally first; check `scripts.test` per package (`bun` vs vitest);
  typecheck-green is not test-checked (test files excluded from typecheck
  tsconfigs — the same trap that made `compat-events.typecheck.ts` dead).
- Validate behavior; never treat typecheck success as proof.

## Execution: parallelize with agents & workflows

Per the inherited parallel-execution mandate. Lanes with disjoint file
ownership; sequence the shared-file pairs.

- **M0** (security, ships first): one agent on the runtime exec/write primitives
  (`process.ts`, `session-env.ts`, `pty.ts`, `git-source.ts`, `target.ts`), one
  on the relay path gate (`workspace-relay/src/server.ts`). Independent.
- **M1**: lane A1+A2 (share `session-core.ts` + `agent-sdk-runtime/src/runtime.ts`
  + `stores/memory.ts` — sequence, don't split), lane A3 (reproduce-first,
  read-only until a gap is confirmed).
- **M2a**: B1 (control-plane workspace + local-host-link mutations, SQLite
  authority), B2 (project identity — shares the authority schema with B1,
  sequence), B3 (token
  layer: `workspace-relay/src/auth.ts`, `runtime-access-token.ts`,
  `workspace-host-service-auth.ts`, relay cache).
- **M2b**: B4 (identity thread + `session_messages`/`session_history` schema +
  mirror + app avatars).
- **M2c**: B5 (policy object + `session_participants` + both authorities), B6
  (revocation wiring + relay teardown), B7 (the eight replay buffers — port
  `live-sync-room.ts`), B9 (two-user harness — new infra).
- **Known traps:** B1/B2/B4/B5 all touch the authority schema — one agent owns
  the schema file per wave, or land EXPAND migrations first. A1/A2 and B5 all touch
  `session-core.ts`. No `git stash` with parallel agents on a shared worktree;
  disjoint ownership or isolated worktrees.
- Adversarially verify the authz slices (B4 attribution-spoofing, B5/B6/B7) with
  a Workflow refute-panel — findings there are security-shaped and must not be
  trusted on first green.

## Open questions for the owner (recorded, non-blocking)

1. Does the workspace-runtime session-route contract test gate Milestone 1?
2. Does production org/project/workspace/session data exist (→ "delete &
   install" vs "install with migration" for the B-items)?
3. Seats on team creation: populate `seats_licensed` now, and does team creation
   become `enforceSeatCapacity`'s add-time choke point?
