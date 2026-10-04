# Reducing Claxedo's server, runtime and machine code

Status: planned, not started. Baseline: `dev` at `79beb849fc`. Evidence reports: `~/test/claxedo-docs-recovered/loc-v2/`.

Task scope updated October 1, 2026: [Task: durable wakes and session memory](2026-09-29-001-feat-tasks-plugin-on-pi-plan.md) retains existing Tasks, adds a shared task-scoped memory tool and one-time wakes, and runs sessions on existing local/cloud runtimes. Task replacement by a hosted plugin is superseded. Numeric targets below retain the original baseline and must be remeasured before use as ceilings: they no longer receive the former 5.6k server deletion or local/MCP Task deletion credit. Neither hosted Pi core, D16 nor a plugin backend platform is a prerequisite for this Task version.

**Scope:** the hosted control plane, the session runtime, the machine agent, desktop main process, the relay, and the MCP, helpers, plugin API and script packages. **Out of scope:** the app and UI kit, the harness package, the marketing site, and native Tasks' app side. Each has its own owner and plan.

## 1. Target

| Component | Packages | Now | Target | Range |
|---|---|---:|---:|---:|
| Control plane | `claxedo-server`, `claxedo-server-core`, `claxedo-connections`, `sandbox-manager`, `egress-broker`, `claxedo-documents-service`, small contracts | 124.9k | 35.9k | 32.5–40k |
| Session core + `workspace-runtime` | `workspace-runtime` → new `session-core` + `workspace-runtime` | 46.5k | 20.4k | 16.8–25.5k |
| Machine agent | `claxedo-local-server`, `claxedo-host-connector`, `claxedo-host-serving`, `cli`, `process-ownership` | 26.0k | 28.1k | 24.4–31.8k |
| Desktop main process | `claxedo-desktop` | 28.3k | 8.8k | 8–10.5k |
| Relay | `workspace-relay`, `workspace-relay-protocol` | 11.0k | 4.1k | 3.5–5k |
| Channels (kept as is) | `claxedo-channels` | 4.0k | 4.0k | — |
| MCP, helpers, plugin API/build, telemetry, `script/` | | 14.1k | 13.0k | 12.2–13.7k |
| **Total in scope** | | **254.8k** | **~114k** | **101–130k** |

**How it's counted:**
- **Files:** tracked `.ts .tsx .mts .cts .js .jsx .mjs .cjs .astro` files under `packages/` and `script/`, without tests, test support, fixtures, e2e, i18n, generated code and `.d.ts`.
- **Deletions** are measured on named files, and are lower bounds.
- **Rewrites** are estimated, ±20–25%.
- **Split:** about 44k of the 141k removal is deletion of named files, and about 20k is code moving between components. The rest is estimated rewrite.

The machine agent grows because it receives Pages' backend (6.9k) and the machine-only code that leaves the control plane.

### 1.1 Where the 141k comes from

| Scope | Mechanism | Lines |
|---|---|---:|
| Control plane (−89.0k) | Delete the self-hosted Node composition and everything only it reaches, except channels | −20.7k |
| | Machine-only code moves to the machine agent (it lands there at ~3.5k) | −12.8k |
| | Pages' local backend moves to the machine agent (unchanged size) | −6.9k |
| | One domain module over D1, with transcript bodies in R2 | ~−9.1k |
| | Plugins as manifests plus the platform, with no plugin-specific D1 code | ~−6.0k |
| | Existing Tasks' server side retained; durable wakes extend its current owners | Former −5.6k credit withdrawn |
| | Delete the documents service deployment (its package, installation ledger and service contract) | −1.9k |
| | Other rewrites, net of +5.3k new code (including org and team access and page sharing, §7.1.2) | ~−26.0k |
| Runtime, machine, desktop, relay (original −50.4k estimate) | Delete managed processes, runtime `perf/`, relay bench, desktop diagnostics, the Bun relay, self-hosted execution; retain local Tasks | Original −14.9k estimate needs remeasurement |
| | Pages' backend arrives from the control plane | +6.9k |
| | Turn row, one projection, one journal sequence (D3) | ~−9.5k |
| | Machine agent in-process (D9) | ~−6.6k |
| | One authorization (D2) | ~−3.2k |
| | Session routes from a contract table, plus a generated client | ~−3.2k |
| | Other rewrites (PTY, status hooks, desktop packaging, CLI), net of ~+6.6k arriving or new (including local page shares) | ~−19.9k |
| MCP, helpers, plugin API, script (−1.1k) | `claxedo-telemetry` deleted | −0.8k |
| | MCP: retain Tasks tools; plugin-declared tools and page-share tools remain separate additions | Original −0.1k estimate needs remeasurement |
| | Helpers and script trimmed; the plugin API gains `claxedo.backend` | −0.2k |

## 2. What this design adds

New concepts and code, about +9.7k in total:

| Addition | Where | Lines |
|---|---|---:|
| **Plugin backends, separate proposal.** Dynamic Worker loading, supervisor/storage, scoped platform APIs, desktop forwarding and plugin MCP tools require an independently scoped consumer and plan. Existing Tasks is not that consumer; durable wakes do not require this platform. | Control plane, plugin API, MCP, desktop | Original ~2.4k estimate; scope needs independent justification |
| **Status-hook templates in plugin manifests** (§7.2.1). Terminal status for a CLI becomes data a plugin declares; Claxedo ships today's nine CLIs as first-party templates. | Plugin API, runtime, machine agent | ~0.3k |
| **Storage rule (D15).** Global D1 holds only small shared facts plus a turn index and a bounded first page per session. Transcript bodies live in R2 as immutable page-sized objects (§7.1.1). Usage facts and audit go to append-only R2 files with a D1 daily rollup and retention. Short-lived tables get sweeps. | Control plane | ~0.9k |
| **One scheduler on the hosted Worker,** shared by the sweeps and the cloud-workspace lifecycle | Control plane | in the above |
| **Cloud-workspace lifecycle owner:** idle stop, reconcile, cleanup, delete, typed failure | Control plane | ~0.5k |
| **boat.dev driver on the hosted path,** on boat.dev's v1 API | Control plane | ~0.5k |
| **Runtime-neutral session core (D16).** One `session-core` package with no `node:*` import runs in `workspace-runtime` and the shared hosted agent runtime's session objects. The host supplies ports: SQLite with `transaction(fn)`, file root, attachments, placement, environment, and an instance-owned event hub. | `session-core` | ~0.2k of ports |
| **Store schema declared once.** The owner is a column on the session, and a store written by another schema is refused at open with a typed error. | `session-core` | net negative |
| **`Principal` and `may()`:** one identity type and one authorization function with a route→action table | Control plane, runtime, relay | ~0.35k |
| **`SessionRef`:** the server issues a session ID plus an explicit hosted-session or native-workspace placement reference; only native placement requires a workspace ID. Coordinate with hosted agent core; never invent a workspace for general chat. | Control plane | original ~0.05k estimate; remeasure for hosted placement |
| **Organization invitations** | Control plane | ~0.25k |
| **Org and team access, end to end** (§7.1.2). Org members can be listed, added, removed and given a role; a project is granted to a team or to one member; a team's grants and a project's access (with the source of each) can be listed; one canonical project-role query. Settings → Organization in the app is the app's lane. | Control plane, account contract, desktop allowlist | ~0.6k (+~0.4k if the SQLite twin gets it too, §8.6) |
| **Private pages with sharing** (§7.1.2). A page records its creator and is private to them; shares go to a person or a team in the page's org, at view or edit; outside the org only a view-only link. One `authorizeDocument` check serves routes, MCP, the CLI, the relay and hydration. Hosted Pages is composed into the Worker for the first time. | Control plane, machine agent, MCP, CLI | ~1.4k |
| **Machine agent responsibilities:** local identity, the machine-side plugin runtime, a hosted-call proxy, in-process remote publication, turn admission | Machine agent | ~2.2k |
| **e2e on the real hosted Worker** instead of the self-hosted Node server | Tests | not counted |

## 3. What users lose

| Loss | Who notices |
|---|---|
| Stored data doesn't carry across the reset. Local session stores from before the schema reset are refused at open, and hosted cloud-session transcripts in D1 are not moved into the new R2 layout. Rulings forbid data migrations. | Everyone with existing sessions (dev data only; unreleased) |
| Usage facts and audit events older than the retention window | Admins reading old usage or audit |
| Daytona and exe.dev cloud workspaces; bringing your own Daytona, Modal or Vercel key | Users of those providers |
| Claxedo MCP `processes` tools: agents run servers in a terminal instead | Agents that used managed processes |
| The local "Total" usage figure from the token-tracker history scan (per-turn usage stays) | Local users |
| Automatic recovery operations: a lost Codex thread or ACP session becomes a visible typed error, and recovery means cancelling the turn | Anyone whose harness session breaks mid-turn |
| The `claxedo host` owner commands, directory-scoped headless hosts, and desktop→CLI single sign-on | CLI users of remote hosting |
| The machine key moves from `safeStorage` to a 0600 file | Desktop users (invisible) |
| Reading every page in a project as an org member: a page becomes private to its creator until shared, and project and org admins don't see private pages either (§8.8) | Org members and admins |

These go with nothing visible lost: the self-hosted Node server and Bun relay (test-only), desktop process diagnostics (no screen uses them), the documents service (a separate deployment the plane never calls), billing (never composed), `claxedo-telemetry`, and five routes that answer "not implemented".

## 4. What remains

- **Harnesses:** Claude Code, Codex, OpenCode (embedded engine), Cursor (`@cursor/sdk`), Pi and generic ACP (custom agents), with goal mode and Claxedo-evaluated goals.
- **Sessions:** everything the app shows today: transcript, composer, questions and permissions, subagents, queue and steering, titles, handoff.
- **Terminal status** for Claude Code, Codex, Cursor, Gemini, Antigravity, Droid, Mastra, Amp and Copilot, now as first-party templates. Any plugin can add another CLI.
- **Pages:** the local and hosted documents backends, runtime hydration into sessions, the MCP `documents_*` tools and the CLI command. Pages are private to their creator and shared with people or teams in the org, or by a view-only link.
- **Org and team access:** org members, teams, and project access per team and per member, manageable end to end (the app's Settings → Organization shows them).
- **Browser pane:** the desktop side.
- **Channels:** the package and its control-plane side, unchanged (§7.3).
- **Machines:** local, other enrolled machines, cloud workspaces on Cloudflare and boat.dev, remote access through the Cloudflare relay.
- **Workbench server side:** terminals, files, git and review, the Marketplace, usage, accounts and credentials, and credential-key rotation as a tooling script.
- **Hosting:** the hosted Cloudflare Worker, which anyone can deploy to their own Cloudflare account with the first-owner claim.
- **Existing Tasks,** extended with a shared memory tool and durable wakes (`2026-09-29-001-feat-tasks-plugin-on-pi-plan.md`). Sessions continue on existing local/cloud runtimes; hosted services persist notes and wakes. Ordinary local-only Tasks remains available.

## 5. Design rules

Every change cites one of these:
- **D1 Identity always exists.** One `Principal`.
- **D2 One authorization function:** `may(principal, action, resource)` and one route→action table. The runtime and relay check a capability and don't re-judge roles.
  - Project access is the highest of: owner, member grant, team grant, org role. One canonical query computes it.
  - Page access adds, after the project gate: creator, person share, team share (the team in the page's org, the person still an org member), or a link (read only).
- **D3 Turn row and one journal sequence.** One status vocabulary; clients take a snapshot plus the numbered stream.
- **D4 `SessionRef`.** No routing by directory strings.
- **D5 Declared capabilities.** No posture, mode or build-flag branches.
- **D6 One owner per concept.** Contracts are imported, never copied; one projection.
- **D8 Control plane = Cloudflare Worker + D1.** One domain module, one Worker entry, one deploy script. First-party sandbox drivers: Cloudflare and boat.dev.
- **D9 The machine agent owns the machine,** in one process.
- **D10 Typed errors,** no swallowed failures, no bridges.
- **D12 Plugins:** UI slots, skills, MCP servers, status-hook templates, and a backend loaded as a Dynamic Worker per organization. Machine-side parts run on the machine agent.
- **D15 Storage rule.**
- **D16 Runtime-neutral session core.**
- **D17 Access vocabulary.** "Team" means only a row in `teams`, an access group inside an org. Anything org-wide says "org": account sources, connection scope, broker identity, `orgs.kind`.

## 6. Starting conditions that set the order

1. **The file-size ratchet is red on `dev`, so no slice can pass `bun run test:architecture-ratchets`.**
   - In scope: `workspace-runtime/src/projection/client-presentation/projection.ts`, 1,568 lines against its 1,524 ceiling.
   - Outside this plan's scope, and blocking it the same way: `claxedo-app/src/transcript/message-part.tsx` (2,589 against 2,580) and `harness/src/transports/codex-app-server/translate/adapter.ts` (1,326 against 1,312), all three grown by `f23e854d0b`; and three built bundles under `packages/storybook/storybook-static/`, which the `wip` commit `388ddd9ea7` added to `dev`.
2. **Both e2e suites boot the self-hosted Node server,** and relay test fixtures use the Bun relay. Those 24k lines can go only once e2e boots the hosted Worker. The e2e harnesses live in the app and harness packages. Changing them is test-only work, coordinated with those owners.
3. **The self-hosted server is also the only host of channels.** Deleting it leaves channels compiled but not running anywhere (§7.3).
4. **The boat.dev driver (`sandbox-manager/src/drivers/box.ts`) is reachable only through the self-hosted server.** It has to be wired into `hosted-sandbox-driver.ts` before that code is deleted.
5. **The hosted Worker has no cron trigger or alarm.**
6. **`CONTROL_PLANE_DB` grows without pruning** in `session_messages`, `usage_turn_facts`, `authority_audit_events`, the turn lease, grant and producer tables, `runtime_access_tokens` and `host_signature_uses`. Audit is capped by count per deployment, so one organization's events evict another's.
7. **The runtime store's schema upgrade is incomplete.** It relies on 29 `ALTER TABLE` statements (22 inside swallowing `try/catch`), `hasColumn` probes and a backfill. Columns added only in `CREATE TABLE` leave older files broken, and a missing `session_owner` row fails the session.
8. **Two things block Durable Object hosting.**
   - `bus.ts` pins the event bus on `globalThis`, and `target.ts` keeps a process-wide directory registry. Both would leak events across hosted session objects that share an isolate.
   - The store opens transactions as `BEGIN`/`COMMIT` SQL text, which Durable Object SQLite refuses.
9. **Hosted Pages has never been deployed.**
   - The hosted Worker mounts no `/documents` routes and binds no documents bucket (`scripts/deploy/wrangler-config.ts`).
   - The hosted backend (`claxedo-server/src/documents/backends/hosted/`, ~2.9k lines, R2 storage with etags and a project index) is complete but unmounted.
   - Pages today is the desktop daemon's local backend (`local-app.ts:491`) and the self-hosted node.
10. **Team routes are live on hosted, but org access can't be managed.**
   - `OrgTeamControlRoutes` is mounted in `hosted-core-app.ts`.
   - Org members have no route: D1 has `addOrganizationMember`, and the SQLite adapter has no equivalent, so teams can't be populated in practice.
   - `project_memberships` feeds the role but is written only at project creation.
   - The role-rank SQL is copied into `agent-plugins/activation/d1-store.ts` beside `d1/workspace-authority.ts`.
11. **"Team" names org-wide things.** It appears in account sources, connection scope, the broker's `team:<org>` identity, `orgs.kind`, and 39 locale files.

## 7. Per component

### 7.1 Control plane: 124.9k → ~35.9k

| Module | Now | Target | Work |
|---|---:|---:|---|
| Worker entry and composition | 4,055 | 700 | One entry and one composition; delete 884 unreached and 187 e2e-only lines; keep the user-deployed owner claim behind `deploy:user-cloudflare` |
| Domain and storage | 24,778 | 2,950 | One domain module over D1; the SQLite twin goes with the self-hosted server; 4.4k moves to the machine agent; conformance suites move to tests; message bodies leave D1 |
| Auth and tokens | 8,063 | 3,750 | One `Principal`, one runtime capability, one relay capability; delete `cli-session-token.ts` and `cli-session-registry.ts` |
| Cloud workspaces | 15,879 | 4,900 | Cloudflare and boat.dev only; delete Daytona, exe, fetch, Vercel, Modal and Docker drivers; boat.dev on its v1 API |
| Routes | 6,026 | 2,400 | Session routes from the contract table |
| Plugins and agent config | 9,550 | 2,750 | Activation and config stay in D1; plugin data lives in the plugin's objects |
| Credentials and accounts | 6,663 | 1,000 | 4.4k moves to the machine agent; KEK rotation becomes a ~150-line tooling script |
| Connections | 5,383 | 1,850 | Delete the four integrations with no consumer; conformance to tests |
| Usage | 4,858 | 1,250 | Append-only facts with a daily D1 rollup |
| Live sync | 1,369 | 700 | |
| Platform | 4,264 | 650 | The installation ledger goes with the documents service; the DB layer moves to the machine agent |
| Org and team access | ~500 | 1,100 | Today's team routes plus org members, per-member project grants and access listing (§7.1.2); one canonical role query; folded into the domain module and `may()` |
| Pages, control-plane side (kept) | 465 | 465 | `documents/relay-http` and the local backend adapter |
| Channels, control-plane side (kept as is) | 2,139 | 2,139 | `channels/*` and `d1/channel-runtime-authority.ts`, untouched |
| Self-hosted Node, supervisor, fixtures | 9,483 | 0 | After e2e boots the hosted Worker |
| Existing Tasks | 5,576 | Retained; remeasure with wakes | No Task deletion phase; extend current domain/store/session bridge |
| Hosted Pages backend | 2,941 | 3,800 | Composed into the Worker with a documents R2 bucket; creator, share store, `authorizeDocument`, share routes, public link route (§7.1.2) |
| Documents service deployment, installation ledger, service contract | 1,914 | 0 | A separate deployment the plane never calls; delete with `.github/workflows/deploy-documents-service.yml` and the `service_*` tables |
| Billing | 1,365 | 0 | Never composed |
| Deploy scripts | 2,512 | 700 | One Cloudflare deploy, plus the loader binding and plugin bundle upload |
| Contracts, egress broker | 2,166 | 950 | `service-contract` goes; the egress broker moves to the machine agent |
| New code | | 3,810 | Plugin platform 1,700, storage rule 880, lifecycle 500, `Principal` and `may()` 350, invitations 250, `SessionRef` 50, `SandboxDriver` 80 (boat.dev's ~500 is inside cloud workspaces) |

#### 7.1.1 Hosted transcripts: D1 plus R2

A cloud session's live data stays on its sandbox. The hosted copy is what the app reads through `/api/control/sessions/:id/outline|page|part`, and those responses don't change.

**Storage.**
- **D1 `session_turns`** (replaces `session_messages`): session, turn number, first and last message position, R2 key, bytes, message count, sealed or open, and the outline fields. About 250 bytes per turn.
- **D1 `sessions.first_page_json`:** the text-only first page the app paints first, with tools as headers, capped at ~16 KB. It is cleared for sessions idle about 30 days; opening one of those reads its latest turn from R2.
- **R2 `sessions/<org>/<session>/chunks/<first-turn>.<hash>.json`:** sealed turns grouped into page-sized chunks of 64–256 KB, plus one object for the open turn.
- **R2 `…/parts/<messageId>/<partId>.<hash>.json`:** tool outputs over ~32 KB. The chunk keeps a stub with the size and key.

**Checkpoint (write).**
1. `syncSessionMessages` checks access and the fencing token first; a stale token writes nothing.
2. It splits messages into turns at each user message and writes only turns that aren't sealed yet. The pull can later ask only for messages after the last sealed turn.
3. It PUTs the chunk and part objects to R2, with a content hash in the key so a new version never overwrites one being read.
4. Then one D1 batch points `session_turns` at the new keys and refreshes `first_page_json`.
5. It deletes the replaced object. The sweep removes any object no D1 row references.

**Reads.**
- **Outline and first read:** D1 only.
- **Older page:** D1 gives the chunk key. The Worker reads the chunk through the Cache API; keys never change, so cached copies never go stale. Depending on the Phase 2 probe, it also warms the next older chunk with `ctx.waitUntil`. Nothing extra goes to the app, so paging stays scroll-up only.
- **Expanding a tool:** the part object, or the part from the cached chunk.

**Delete.** D1 rows go at once; the scheduler deletes the R2 prefix in batches of 1,000 keys.

#### 7.1.2 Access: orgs, teams, projects and pages

Two work briefs (2026-09-30) define this; this plan carries their outcome and ordering.

**The model.**
- An **org** is the tenant and its shared configuration.
- A **team** is an access group inside one org (`teams`, `team_memberships`).
- **Project access** is the highest of four sources: the owner, a member grant (`project_memberships`), a team grant (`team_project_grants`), or an org role. One canonical query computes it; today's copy in `agent-plugins/activation/d1-store.ts` goes.
- **Page access** comes after the project gate: the creator, a share to a person in the page's org, a share to a team in that org, or a link token (read only). Nobody outside the org gets access by person. Denials are 404.

**What exists and what is added.**

| Piece | Today | Added |
|---|---|---|
| Orgs and teams | Routes live on hosted: `/orgs`, `/orgs/:orgId/teams`, `/teams/:id/members`, `POST`/`DELETE /teams/:id/projects` | Org members: `GET`/`POST`/`DELETE /orgs/:orgId/members` and a role change. Removing a member also removes their team memberships and project grants in that org. |
| Per-member project grants | `project_memberships` feeds the role; only the owner row is ever written | `POST`/`DELETE /projects/:projectId/members` with viewer, editor or admin, under the same rules and errors as team grants; the owner row can't change |
| Listing | None | `GET /teams/:teamId/projects`; `GET /projects/:projectId/access`, which gives each grant with its source |
| Pages | Every org member reads every page in the project; no creator is recorded; hosted Pages isn't mounted | The creator is recorded; one share store (`document_id`, target person, team or link, level, `created_by`, `revoked_at`; link tokens stored hashed); `authorizeDocument` on every path; filtered lists; `/documents/:id/shares`; a public, rate-limited `GET /p/:token` |
| Desktop | `team.projects.grant` only | Revoke, org-member, project-member and listing operations in `account-contract` and the allowlist |

**Where the code lands.**
- The authority port and the D1 adapter hold the access methods.
- The hosted documents backend and the local one each record creators and shares. The local store is SQLite, and it is reached by other org members through the relay.
- The vocabulary rename (D17) touches `account-contract`, the local broker, `claxedo-connections`, the app and the locale files. `orgs.kind 'team'` becomes `'shared'` through one D1 migration and the SQLite schema, with no dual read.

**Order.**
1. The access work (members, grants, listing, one role query, vocabulary).
2. Then pages, which need org membership and teams to decide shares.
3. Both land before Phase 5's `may()`, which is built over the canonical role query rather than beside it.

### 7.2 Session core and `workspace-runtime`: 46.5k → ~20.4k

**`session-core` (new), ~9.8k:**

| Piece | Now | After D3 |
|---|---:|---:|
| `store.ts` | 5,039 | ~1,800 |
| `session/` | 1,416 | ~1,000 |
| `projection/` | 3,001 | ~1,300 |
| `broker-ports/` | 758 | ~650 |
| `host/`, Node-free part | 5,135 | ~2,600 |
| Session routes (13 files) | 4,246 | ~1,600 |
| Event stream | 1,575 | ~400 |
| Shared and port types | 310 | ~450 |

Node reaches these files in 13 places. Each becomes a port that the host supplies:
- the SQLite driver, file root, backups and PRAGMAs;
- `transaction(fn)`;
- `Buffer` and `randomBytes`;
- `node:crypto` `randomUUID` (11 files);
- a synchronous HMAC in `session-children.ts`;
- the Pages hydration hook, an optional session-lifecycle port that a Durable Object host doesn't supply;
- attachment bytes;
- directory placement;
- `process.env`;
- the event bus;
- launch-ownership and worktree records.

**`workspace-runtime` (Node), ~10.6k:**
- **Stays:**
  - the SQLite opener;
  - PTY;
  - files and git;
  - the status-hook engine (§7.2.1);
  - host executables and composition;
  - boot;
  - the client;
  - Pages hydration routes (1.1k);
  - the policy implementation until D2;
  - the Cursor transcript resolver and OpenCode staging, owned with their transports.
- **Deleted:**
  - managed processes and `routes/process.ts` (2.9k);
  - `perf/`;
  - five "not implemented" routes and the unused synchronous message route;
  - the event-delivery rings and the recovery ledger (D3).

**In a Durable Object host:** Pi's session owns the model conversation, and the session core's journal owns what clients read.

The [hosted agent core proposal](2026-10-01-001-feat-hosted-agent-core-plan.md) owns a possible later Worker runtime and storage/event adapters. Current Task scope runs on existing local/cloud sessions and exposes durable notes through a memory tool. A future Pi runtime consumes that same memory service. D16 remains the owner of the runtime-neutral extraction, but does not block current Task memory/wakes.

#### 7.2.1 Terminal status through plugin templates

**Today:** `workspace-runtime/src/agent-hooks` (2.2k) reports running, waiting and done for agent CLIs started inside a Claxedo terminal tab. It knows nine CLIs, and each is hard-coded:
- **Claude Code and Codex** go through a wrapper that adds hook flags, and write nothing into the person's folders.
- **Cursor, Gemini, Antigravity, Droid, Mastra and Amp** get Claxedo's entries merged into the person's own config file through `config-merge.ts`.
- **Copilot** gets a per-project hook file.

Every hook script calls `notify.template.sh`, which posts the event to `/api/wr/hook/agent-lifecycle`, keyed by tab and terminal. The runtime then maps it to a status.

**Proposed:** keep the engine, and move each CLI's specifics into a template declared by a plugin manifest (`claxedo.statusHooks`):

| Template field | What it says | Example |
|---|---|---|
| `command` | The CLI binary the template applies to | `gemini` |
| `install` | How the hook reaches the CLI: `wrapper-flags` (arguments added when a tab runs it), `config-merge` (a file path plus the JSON entries to merge), or `project-file` (a file written in the project and excluded from git) | `config-merge`, `~/.gemini/settings.json`, `hooks.BeforeAgent`… |
| `events` | The CLI's hook events, and the status each maps to: running, waiting, done or ignored | `AfterAgent` → done |
| `subagent` | Which payload field marks a subagent's event | `agent_id` |

**The flow:**
1. A plugin with a status-hook template is activated on a machine.
2. The machine agent's plugin runtime hands the template to the runtime's engine.
3. The engine installs the hook: the wrapper, the `config-merge.ts` edit (with its existing safety rules), or the project file.
4. When the person runs the CLI in a tab, the hook posts to `/api/wr/hook/agent-lifecycle`.
5. The engine maps the event through the template, and the tab shows the status.

- **What stays in core:** the engine, meaning the wrappers, `config-merge.ts`, the notify script, the lifecycle route and the subagent rules. It lands at about 1.2k, down from 2.2k.
- **What users see:** Claxedo ships today's nine CLIs as a first-party plugin that is active by default, so nobody loses status. Anyone can add another CLI by publishing a template, without a Claxedo release.

### 7.3 Machine agent, desktop, relay, channels: 69.3k → ~45.0k

- **Machine agent ~28.1k.**
  - It holds its own code (~9.0k), Pages' local backend (6.9k, plus ~0.3k for creators, shares and `authorizeDocument` on the relay path), the control plane's machine-only code (~3.5k after rewrite) and the folded connector and serving (~2.1k).
  - New responsibilities add ~2.2k, including the plugin runtime that installs status-hook templates.
  - `process-ownership` stays at ~2.2k and takes launch ownership from the runtime. The CLI shrinks to ~1.5k.
  - Deleted:
    - self-hosted execution;
    - the Total scan;
    - the CLI's second host loop and `claxedo host` commands.
  - CLI test support moves to tests.
- **Desktop main process ~8.8k.**
  - Kept: the browser pane (2.5k).
  - Deleted: process diagnostics and the profiler (7.4k); the host-connector child (2.7k, D9); the daemon recovery bridge (536); packaging machinery.
  - The hosted-operations table is declared once.
- **Relay ~4.1k.** The Bun relay (3.1k) and bench (1.0k) go; D2 removes role claims; `server.ts` loses its dead exports.
- **Channels, kept as they are.**
  - `claxedo-channels` (4.0k) and the control-plane side (2.1k) are not changed.
  - Their only host today is the self-hosted server. After Phase 5 deletes it, they compile and keep their tests but don't run anywhere, until their host is decided (§8).

### 7.4 MCP, helpers, plugin API, script: 14.1k → ~13.0k

- **MCP:** retains existing Tasks tools, with wake commands added by that feature; plugin-declared tool forwarding and page-share tools (`documents_share`, `documents_unshare`, `documents_list_shares`, link create and revoke) remain separately scoped.
- **Helpers:** test support moves out.
- **Plugin API:** gains the `claxedo.backend` and `claxedo.statusHooks` manifest fields.
- **`claxedo-telemetry`:** deleted.
- **`script/`:** ~4.5k.

## 8. Decisions needed (recommended defaults)

1. **Target:** adopt the per-component targets as ratchet ceilings that only go down.
2. **Channels' host after the self-hosted server goes:**
   - *Default:* leave them unhosted and unchanged, and decide later.
   - *Alternative:* run them on the machine agent.
3. **Cloud sandboxes:** they run the machine agent, not a bare runtime.
4. **Bring-your-own sandbox keys:** operator account only, for Cloudflare and boat.dev.
5. **Test code:** capped at production size.
6. **The SQLite authority twin and the new access methods.**
   - The teams brief asks for every new method in both the SQLite and D1 adapters.
   - The SQLite adapter is reached only by the self-hosted test server, which Phase 5 deletes.
   - *Default:* implement the access methods in D1 only, with the conformance suite and the route-level flow on D1 under workerd, after the e2e-off-self-host lane. The SQLite twin's team methods go with it.
   - *Alternative:* both adapters, as the brief says, knowing the SQLite half is deleted in Phase 5.
7. **Hosted Pages:** compose the hosted documents backend into the Worker with a documents R2 bucket.
   - *Default:* yes. Org and team shares and public links need a hosted home.
   - Without it, sharing exists only for desktop pages reached through the relay.
8. **Page-sharing defaults** (the Pages brief's, to confirm):
   - person and team shares carry view or edit;
   - a link is view-only, unguessable and revocable;
   - project and org admins don't see private pages;
   - archive is the creator's, or an edit-share holder's the creator chose.

Already decided:
- Hosted transcripts use D1 plus R2 (§7.1.1).
- Pages, Teams, the browser pane and channels are kept.
- "Team" means only a `teams` row; org-wide things say "org" (2026-09-30).
- Pages are private to their creator and shared only with org members, org teams or by link (2026-09-30).

## 9. Phases

Each phase ends when its criteria pass through real entrypoints: the hosted Worker on workerd, the desktop signed and unsigned, and the web app. Every slice:
- deletes what it replaces in the same change;
- runs `bun run test:architecture-ratchets` on the merge tip;
- lowers its component's ceiling.

### Phase 0: Safety net

- [ ] `projection.ts` is split by responsibility under the 800-line budget, with no ceiling raised; the app, harness and `wip`-commit failures in §6.1 are cleared by their owners. Progress:
- [ ] Per-component line ceilings from §1 are recorded in the ratchet. Progress:
- [ ] The app and harness e2e harnesses boot the hosted Worker on workerd or the local daemon; nothing boots `self-hosted-node` or the Bun relay. This is test-only work, agreed with those packages' owners. Progress:
- [ ] Staging `CONTROL_PLANE_DB` is measured: size, bytes per table, write rate. Progress:

### Phase 1: Deletions that need no replacement

- [ ] **Unreached code:** the documents service with its deploy workflow and `service_*` tables, billing, `claxedo-telemetry`, `cli-session-token.ts`, the Worker spike entry. The hosted documents backend stays: Phase 1A composes it. Progress:
- [ ] **Features leaving core:**
  - managed processes (runtime, routes, MCP `processes`, PTY managed mode);
  - the Total scan;
  - runtime `perf/`;
  - the relay bench and `runtime-recovery-smoke`;
  - desktop diagnostics;
  - the Daytona and exe drivers.
  
  Progress:
- [ ] **Dead routes:** the five "not implemented" passthroughs and the synchronous message route. Progress:
- [ ] **Test support and conformance suites move next to their tests:** 2.0k in the control plane, 1.7k in the CLI and host connector, 0.2k in helpers and MCP. Progress:
- [ ] Repository search finds no importer of anything deleted, and each package's tests and typecheck pass. Progress:

### Phase 1A: Access model

- [ ] **Vocabulary (D17).** Every org-wide "team" becomes "org": `AccountSource "org"`, `ConnectionScope "org" | "personal"`, the broker identity `org:<orgId>`, the wire field `org`, and the locale keys and copy ("Organization account"). `orgs.kind 'team'` becomes `'shared'` through one D1 migration and the SQLite schema. A string grep, including `"team" in x` guards, finds no org-wide use left. Progress:
- [ ] **One canonical project-role query,** used by the D1 authority and the plugin activation store. Progress:
- [ ] **Org members:** list, add, remove and role change, on the authority port and the D1 adapter (and SQLite per §8.6). Removal also drops the person's team memberships and project grants in that org. Progress:
- [ ] **Per-member project grants** over `project_memberships`, under the team-grant rules and errors, with the owner row immutable. Progress:
- [ ] **Listing:** a team's projects, and a project's access with sources. The desktop allowlist and `account-contract` carry every new operation. Progress:
- [ ] The teams brief's done criteria pass:
  - conformance for grant, re-grant, revoke, cross-org rejection, non-admin rejection, and access lost on the next request;
  - the route-level flow: org → member → team → team editor grant → workspace opens → revoke → denied → a per-member grant alone gives access.
  
  Progress:
- [ ] **Hosted Pages composed** into the Worker with its R2 bucket (§8.7). Progress:
- [ ] **Private pages** per the Pages brief:
  - the creator is recorded;
  - one share store;
  - one `authorizeDocument` behind routes, MCP, the CLI, the relay and hydration (grep proof);
  - filtered lists, the share API and `GET /p/:token`;
  - its done criteria pass on both backends.
  
  Progress:
- [ ] `docs/tech-docs/access-model.md` states the glossary (org, team, project access, page access) and the routes. Progress:

### Phase 2: Storage rule on hosted

- [ ] One scheduler on the hosted Worker. Progress:
- [ ] R2 latency probe from two regions: uncached and cached reads of 64 KB and 256 KB objects, compared with today's `latestView` D1 page query. The results set the chunk size and whether the Worker warms the next page. Progress:
- [ ] Transcripts on D1 plus R2 (§7.1.1):
  - first read and outline touch only D1;
  - older pages and large parts come from R2 through the Cache API;
  - a checkpoint writes only unsealed turns;
  - `/api/control/sessions/:id/outline|page|part` responses are unchanged;
  - `session_messages` is dropped.
  
  Progress:
- [ ] Failure tests:
  - an R2 write failure leaves D1 unchanged;
  - a D1 commit failure leaves only an unreferenced object, which the sweep removes;
  - a stale fencing token writes nothing;
  - a referenced object that is missing returns a typed error.
  
  Progress:
- [ ] Usage facts go to append-only storage with a daily D1 rollup, and audit gets time retention. Progress:
- [ ] Sweeps run for turn leases, grants and producers (producers only after the usage window), `runtime_access_tokens` and `host_signature_uses`. A test proves expired rows go and live rows stay. Progress:

### Phase 3: Session core, then the turn row

- [ ] **Store schema reset:**
  - one declared schema;
  - the owner is a column on `session`;
  - the `ALTER`, `hasColumn`, backfill and snapshot paths are deleted;
  - a store from another schema is refused at open with a typed error.
  
  Progress:
- [ ] **Ports in place inside `workspace-runtime`:** all 13 Node dependencies sit behind ports, the bus and placement registry are instance-owned, and a ratchet forbids `node:*` in the core folders. Progress:
- [ ] The store suite passes on `better-sqlite3` **and** on Durable Object `ctx.storage.sql` under workerd. That covers `transactionSync`, the PRAGMA whitelist and the `changes`/`lastInsertRowid` equivalents. Progress:
- [ ] **Move to `session-core`,** with one entry that `workspace-runtime` composes. The H-9, H-15, H-16 and H-17 route tests pass unchanged, and H-14 becomes a required placement port. Progress:
- [ ] **Turn row, one projection and one journal sequence:** the recovery ledger, event-delivery rings and the live/stored projection split are deleted, and H-NEW-corpus-1, H-NEW-corpus-3 and H-25 are closed. Progress:

### Phase 4: Plugins

Plugin backends no longer have their implementation scope in the Task plan; they require an independent plan before adoption. Existing Tasks and its stores/tools remain. Durable wake scheduling can reuse the shared scheduler work without waiting for plugin hosting. Shared Pi execution remains owned by `2026-10-01-001-feat-hosted-agent-core-plan.md` and coordinates its journal adapter with Phase 3.
- [ ] **Status-hook templates (§7.2.1):**
  - `claxedo.statusHooks` has a schema and validation;
  - the engine installs a template through each of its three install kinds;
  - the nine CLIs ship as a first-party plugin active by default, and each still reports running, waiting and done in a tab;
  - a test template for a tenth CLI works without an engine change.
  
  Progress:

### Phase 5: Foundation, then the self-hosted server goes

- [ ] `Principal` and `may()` with one route→action table, built over Phase 1A's canonical role query and `authorizeDocument`, and landed before the plugin supervisor object. Progress:
- [ ] `SessionRef` issuance. Progress:
- [ ] Cloud-workspace lifecycle owner on Phase 2's scheduler. Progress:
- [ ] boat.dev's driver runs on its v1 API from `hosted-sandbox-driver.ts`, with secret staging verified against the live API. Progress:
- [ ] Delete the self-hosted server and everything only it reaches, except channels (20.7k), and the Bun relay (3.1k). Progress:

### Phase 6: Component rebuilds

Each against its ceiling in §1:
- [ ] **Control plane:** one domain module, one Worker entry, routes, connections, usage. D1 adapters over 800 lines are split by responsibility. Progress:
- [ ] **Machine agent in-process:** connector, serving and tunnel fold in; the desktop connector child and CLI host loop go; machine-only control-plane code and Pages' backend arrive. Progress:
- [ ] **Desktop main process:** the hosted-operations table is declared once; the recovery bridge and packaging machinery go. Progress:
- [ ] **Relay:** dead exports and role claims go. Progress:

## 10. Definition of done

- [ ] Every in-scope component is at or under its §1 ceiling, enforced by the ratchet.
- [ ] Nothing in `packages/` remains of: `self-hosted-node`, the Bun relay, managed processes, desktop diagnostics, telemetry, the documents service or billing. Existing Tasks is retained.
- [ ] Pages, teams, the browser pane and channels work through their entrypoints:
  - org members, teams, and project access per team and per member are manageable end to end;
  - pages are private to their creator and shared per §7.1.2 through one `authorizeDocument`;
  - MCP `documents_*` and runtime hydration work;
  - the desktop browser pane works;
  - the channels package tests pass.
- [ ] No "team" string means anything org-wide (grep shown).
- [ ] All nine CLIs report terminal status through first-party templates.
- [ ] Global D1 holds no transcript, usage-fact or audit body (only turn index rows and bounded first pages), and every short-lived table has a sweep.
- [ ] `session-core` has no `node:*` import and runs in `workspace-runtime` and shared hosted agent core session objects, serving general chat and Task through the same client contract.
- [ ] A store from another schema is refused at open with a typed error.
- [ ] Ratchets, typecheck, the affected packages' tests, and the app and harness e2e pass on the merge tip.
- [ ] The architecture docs describe the result, and this plan is deleted.

## 11. Execution

Lanes run in parallel. Each lane is an Opus agent in its own worktree, with disjoint file ownership. The orchestrator reviews each diff, cherry-picks it onto the merge tip, and runs the ratchets there before merging.

| Lane | Owns | Starts |
|---|---|---|
| Ratchet green | `workspace-runtime/src/projection/**` | Immediately |
| e2e off self-host | `claxedo-app/e2e/harness/**`, `packages/harness/e2e/harness/**` (tests only) | Immediately |
| Phase 1 deletions | the Phase 1 lists, one sub-lane per package | Once the ratchet is green |
| Access model | `platform/auth/authority.ts` access methods, the D1 adapter's org, team and project-member methods, `session/routes/org-team-routes.ts`, the access-model doc, `account-contract` and the desktop allowlist access operations, the vocabulary rename | Once the ratchet is green; per §8.6, D1-only after the e2e-off-self-host lane |
| App: Settings → Organization | `claxedo-app/src/access/**` (the app's lane) | Against the Access model routes |
| Private pages | `server-core/src/documents/**`, `claxedo-server/src/documents/**`, the Worker's documents mount and bucket, `claxedo-mcp/src/tools/documents.ts`, `cli/src/commands/documents.ts` | After the Access model lands |
| Storage rule | `claxedo-server/src/**` transcript, usage, audit, sweeps, scheduler; `wrangler-config.ts` | After the staging measurement |
| Session core | `workspace-runtime/src/{store.ts,session,projection,broker-ports,host,routes/session*,routes/events.ts,event-delivery.ts,bus.ts}` → `packages/session-core` | Schema reset immediately; ports after it |
| Status-hook templates | `workspace-runtime/src/agent-hooks/**`, `claxedo-plugin-api` manifest | After Phase 1 |
| Task memory and durable wakes | Existing Tasks domain/store, MCP tools, hosted clock and native session admission; see `2026-09-29-001` | Independent of hosted Pi, D16 and plugin hosting |
| Foundation | `claxedo-server-core/src/platform/auth/**`, `sandbox-manager/**` | After the scheduler and the Access model land |

The Durable Object SQLite store gate (Phase 3) can change this plan. The previous Task facet gate is superseded; durable wakes do not introduce Task facets or per-task runtime objects.

## 12. Risks

1. **Most of the reduction is moves and estimated rewrite.** About 44k of the 141k is deletion of named files; the rest carries ±20–25%.
2. **Deletion counts are lower bounds.** Code reachable only from deleted files isn't counted until found.
3. **The machine agent is the least certain component.** The control plane's 12.8k of machine-only code is estimated to land at ~3.5k there.
4. **Durable Object SQLite semantics are unverified for the store:** `transactionSync` only, the PRAGMA whitelist, 15 uses of `changes`/`lastInsertRowid`, and the per-object size ceiling.
5. **`session_messages` grows every week of hosted use** in one database shared by every organization. Phase 2 starts the new layout empty.
6. **With no bridges, each slice switches every user at once.** Phase 0's e2e gate is what makes that safe.
7. **R2 read latency is unmeasured for our Worker.** Community reports give 100–200 ms typical and 400–600 ms for about 10% of reads. Scrolling up and expanding tools pay it on an uncached read; the Phase 2 probe decides chunk size and next-page warming.
8. **The access changes land before the domain-module rewrite,** so the rewrite must carry them. The Access lane's conformance suite and route-level flow are its guard.
9. **Hosted Pages has never run in production.** Its R2 etag writes, project index and relay paths are exercised only by tests until Phase 1A composes it.
