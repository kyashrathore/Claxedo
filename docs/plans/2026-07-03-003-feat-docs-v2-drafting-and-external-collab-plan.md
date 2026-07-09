---
title: "feat: Docs v2 — Agent Drafting Core + External Doc Collaboration (Google Docs, Notion, Confluence)"
type: feat
status: draft
date: 2026-07-03
---

# feat: Docs v2 — Agent Drafting Core + External Doc Collaboration

> **Amendment (2026-07-10, restoration + connections update):** this document
> was deleted from the working tree during the pre-hard-fork docs trim
> (history reset 2026-07-09) and has been restored with corrections. Two
> material changes since first authoring:
> 1. **The connections framework is now IMPLEMENTED** — `@claxedo/connections`
>    kit (`packages/claxedo-connections`: registry, attempt state machine,
>    token service, impls for google/notion/atlassian/github) + claxedo-server
>    host (`src/connections-host/`, `storage/connection.sql.ts`, mounted at
>    `/api/claxedo/integrations`) + app UI (`settings-connections.tsx`,
>    `dialog-connect-integration.tsx`). **LANE CX below is COMPLETE**; its
>    code-grounded reference is
>    `docs/plans/2026-07-03-004-feat-connections-framework-plan.md`. Google
>    registers only when `CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID/SECRET` are
>    present.
> 2. `docs/plans/pages-goal.md` (and most pre-fork plan docs) were deleted in
>    the trim — references to it below are historical; the pages *code* is
>    fully intact and remains the delete target.
> 3. **Packaging decision changed (2026-07-10): docs are NATIVE, not a
>    plugin.** Provider/collab logic ships as a kit
>    (`packages/claxedo-doc-collab`) composed into claxedo-server — the same
>    pattern as `@claxedo/connections` — with `doc_*` tools added to the
>    existing `claxedo-mcp` server and skills shipped first-party. No
>    agent-extensions package, no marketplace install. Rationale: the store,
>    routes, and ALL UI must be core anyway (no frontend extension points), so
>    a plugin could only carry the tools/skills slice and would version-skew
>    against core routes. Bonus simplification: provider HTTP happens
>    server-side, so OAuth tokens never leave the server process.
> Naming caveat: `packages/claxedo-docs` (`@claxedo/docs`) is the Mintlify
> docs SITE — unrelated; hence the kit name `claxedo-doc-collab`.

## Overview

Replace the native pages system with a two-part docs architecture. **Core keeps
only a drafting substrate**: markdown-canonical docs with an append-only
revision log, stored locally, agent-first — the surface Arena's multi-agent
drafting physically requires (external provider APIs cannot host it: Notion is
~3 rps, Google Docs edits are batch/revision-gated). **A doc-collab kit
composed into claxedo-server owns the entire collaboration loop**: publish a
revision to Google Docs / Notion / Confluence,
where humans comment using tools they already have; an AI session grounded in
the linked project's codebase then reads the comments, edits the doc, replies
on the threads, and resolves them.

The current pages implementation is acknowledged scrappy (author's words) and
is **rebuilt, not migrated**: `claxedo_page` + arena tables are wiped and
replaced with a clean schema. The org→project identity foundation in Convex is
untouched — it is shared substrate for the sessions rewrite and hybrid
sessions.

## At A Glance

The product is a loop, not a pipeline:

```text
  ┌─────────────── WORKSHOP (core, local) ───────────────┐
  │  you + agents brainstorm → doc revision N            │
  │  (Arena v2: multiple agents, one doc, no rate limits)│
  └──────────────┬────────────────────────▲──────────────┘
                 │ publish rev N          │ revision round
                 ▼                        │ (big feedback → rev N+1 → re-publish)
  ┌─────────────── SHOWROOM (external provider) ─────────┐
  │  Google Doc / Notion page / Confluence page          │
  │  humans share + comment with native provider UX      │
  └──────────────┬────────────────────────▲──────────────┘
                 │ comments               │ quick resolve
                 ▼                        │ (small feedback: edit doc at source,
  ┌─────────────── RESOLVE (agent session) ──────────────┐   reply + resolve thread)
  │  grounded in the linked project's codebase           │
  │  per-thread: investigate → edit/answer → reply       │
  └───────────────────────────────────────────────────────┘
```

Desired first impression:

```text
/docs draft "Channels layer PRD"        → agents draft rev 1 in the workshop
/docs publish → Google Docs             → real Google Doc, share with your PM
  (PM comments over the weekend, in Google Docs, no Claxedo account)
/docs resolve-feedback                  → agent fixes 4 comments in the doc,
                                          answers 1 with a code citation,
                                          asks a clarifying question on 1,
                                          posts a summary in chat
```

## Proposal (decision record)

**Problem.** The target flow — draft with AI, share, collect human feedback,
have AI resolve it — is unreachable on native pages without rebuilding a
collaboration suite: pages have no comments, no share links, no public
hosting, and sharing is gated behind a signed-mode/identity program that is
deployed nowhere (all shipped builds bake `authEnabled=false`). Reviewers (PMs,
clients, teammates) live in Google Docs / Notion / Confluence and will not
install Claxedo to leave a comment. Meanwhile the one genuinely differentiated
piece — Arena, multi-agent drafting on one doc — requires a local store and
dies if pages are deleted wholesale.

**Decision.** Split by what each side can uniquely do. Local store = only
place multi-agent drafting can run. External providers = only place reviewers
already are. Core keeps the drafting substrate; the doc-collab kit owns
publish, feedback, and resolution. The pages *product* (board, statuses,
git-commit flow, in-app editor as destination, native sharing/Yjs roadmap) is
deleted.

**Alternatives rejected:**

- *Keep native pages and build comments/sharing/realtime natively* — months of
  work to reach feature parity with tools reviewers already use, gated behind
  the undeployed auth program, and it fights reviewer habits forever.
- *Delete everything including the store; Arena on external docs* — infeasible:
  provider rate limits and revision-gated batch edits cannot host concurrent
  agent editing.
- *Arena drafts as repo markdown files* — rejected by product decision: plans
  and PRDs do not belong in source code. Docs get their own home.
- *Keep both systems as-is* — permanent split product story ("where does this
  doc live?") and maintenance of an editor that cannot win against Notion.
- *Three separate provider plugins* — triples auth/skill/registry plumbing and
  gives agents three tool vocabularies for one job.
- *Ship it as a separate agent-extensions plugin package* — rejected
  2026-07-10: the tables, routes, and all UI must be core regardless (no
  frontend extension points), so a plugin could carry only the tools/skills
  slice, running as an extra MCP process that version-skews against core
  routes; installing/uninstalling wouldn't add/remove any UI. Reserve the
  plugin mechanism for third-party integrations.
- *Adopt executor.sh as the connections layer* — see Connections Framework
  below; not adopted (and now moot: the first-party framework shipped).

## Locked Decisions

Do not re-litigate inside a lane; if one proves impossible, stop and report.

1. **Rebuild, not migrate.** `claxedo_page` + page-arena tables are dropped and
   replaced (sanctioned pre-release wipe). Export any dogfood pages worth
   keeping before the removal lane merges.
2. **Drafting substrate in core; provider logic in the kit.** Docs +
   revisions + Arena are core. Everything that talks to a provider lives in
   `packages/claxedo-doc-collab`, composed into claxedo-server like
   connections. No provider HTTP outside the kit.
3. **Markdown is canonical.** Doc content is markdown (agents are first-class
   authors). Tiptap JSON is retired. The in-app editor is a markdown surface;
   rich rendering is a view concern.
4. **Append-only revision log** replaces the version-int. Every content write
   creates a `doc_revision` row (author kind: user|agent, optional session
   provenance). Publish binds to a specific revision. Optimistic concurrency:
   writers pass `parent_revision_id`; mismatch → 409 (no silent clobber).
5. **No git coupling.** Docs are not repo files. `from-repo` and
   `commit-to-git` flows are deleted, not ported. (Product decision: plans/PRDs
   don't belong in source code.)
6. **No manual status board.** Doc state is derived from lifecycle: `drafting`
   (no publication) / `published` / `feedback_open` (unresolved comments >0) /
   `resolving` (resolution session active). No hand-set columns in v1.
7. **One kit, three destinations, one `DocDestination` interface** with an
   explicit capability matrix. Every capability gap maps to a typed `outcome`
   (never a silent no-op) and the resolve skill states the fallback in its
   reply. Vocabulary: in code the external services are **destinations**
   (where a published copy lives) and **connections** (the authenticated
   account, owned by `@claxedo/connections`) — never "provider", which is
   already taken twice (model providers, harness providers). Prose may say
   "provider" informally.
8. **Sharing is provider-native.** The kit never rebuilds ACLs. Claxedo
   keeps only org/project scoping on the internal store (reusing the existing
   `projectRole`/`authorizeProject` chain) plus publication metadata.
9. **Polling in v1; webhooks deferred.** All three providers' webhook stories
   need public HTTPS endpoints local-first Claxedo doesn't have.
10. **Connections framework is first-party in claxedo-server-owned code** —
    DECIDED AND SINCE IMPLEMENTED as `@claxedo/connections` + connections-host
    (see Amendment + Connections Framework section). Not built on
    `packages/core` (upstream, private, unpublished). The docs kit consumes
    connections; it never owns auth.
11. **Central token refresh; tokens never leave the server.** The connections
    kit's token service owns OAuth refresh. Because the doc-collab kit runs
    inside claxedo-server, provider HTTP happens server-side: the claxedo-mcp
    `doc_*` tools call `/docs` routes, never providers — so agents, MCP
    processes, and clients never see any token (this deletes the earlier
    open question about an MCP-consumable live-token route).
12. **Google Docs is the reference provider.** The end-to-end demo gate runs on
    Google (only provider with full API resolve). Notion and Confluence ship in
    v1 behind the same interface with documented degradations.
13. **Two resolution modes.** Quick-resolve at source (small fixes: edit the
    external doc, reply, resolve) and revision round (big feedback: pull
    comments into a new internal drafting round → revision N+1 → re-publish →
    reply "addressed in vN+1"). The skill classifies per-thread; the user can
    force either mode.
14. **Publish is one-way in v1.** Foreign edits (humans editing the published
    doc directly) are handled by an explicit "import external as new revision"
    command — no automatic merge. Divergence is surfaced as publication state
    `foreign_edits`, never silently overwritten by re-publish (re-publish over
    foreign edits requires explicit confirmation).
15. **Identity foundation untouchable.** `convex/projects.ts`,
    `convex/projectMemberships.ts`, `convex/model.ts` role chain,
    `convex/orgs.ts` (`ensurePersonalOrg`), Clerk webhook, and the
    control-plane authority port are shared substrate — no lane may modify or
    delete them.
16. **Loopback-local keeps working unsigned** (`__local__` org sentinel,
    project = workspace id). The kit additionally works loopback: provider
    OAuth is a user-level connection, not a signed-mode feature.
17. **Arena v2 in this plan = re-point, not rethink.** Arena moves onto the new
    doc/revision store with minimal behavior change. A deeper arena redesign
    (agents-as-sessions, coordination model) is deferred work with its own doc.
18. **Google OAuth scope = `drive.file` + `documents`** (faster review; limits
    comment access to docs the app created/opened — acceptable since the
    kit creates the docs). Notion ships a `key` method
    (internal-integration secret) alongside OAuth; Confluence ships a `key`
    method (API token) alongside 3LO — both dodge app-review calendar risk for
    solo users. Cross-check against what the shipped connection impls
    (`packages/claxedo-connections/src/impls/`) already support.

## Source Documents

Intent sources; verify all code claims against current source before editing.
**Never navigate by line numbers — grep for symbols.**

- This plan (wins over everything below on conflicts).
- Connections framework (implemented):
  `docs/plans/2026-07-03-004-feat-connections-framework-plan.md` +
  `packages/claxedo-connections/src/` +
  `packages/claxedo-server/src/connections-host/`.
- ~~`docs/plans/pages-goal.md`~~ — deleted in the 2026-07-09 hard-fork trim;
  its surviving relevance (org/project scoping + gating patterns) is restated
  in this doc and visible directly in the pages code.
- Pages backend today: `packages/claxedo-server/src/routes/pages.ts`,
  `pages-arena.ts`, `page-store.ts`, `page-content.ts`, the `page-arena-*.ts`
  modules, `packages/claxedo-server/src/storage/page.sql.ts`,
  `page-arena.sql.ts`.
- Pages frontend today: `packages/claxedo-app/src/claxedo-ui/components/page-*`,
  `tab-page*`, `packages/claxedo-app/src/utils/pages-api.ts`.
- MCP tool seam: `packages/claxedo-mcp/` (first-party MCP server the `doc_*`
  tools are added to).
- UI contribution seams:
  `packages/claxedo-app/src/shell/contributions/first-party-surfaces.tsx`,
  `first-party-content-surfaces.tsx`, `registry.ts`,
  `components/prompt-input/slash-popover.tsx`,
  `claxedo-ui/context/claxedo-layout/types.ts` (TabType, TabItem.badge,
  attention), `browser/components/browser-pane.tsx` (Electron webview).
- Connections UI (implemented):
  `packages/claxedo-app/src/components/settings-connections.tsx`,
  `dialog-connect-integration.tsx`.

## Corrected Reality (re-verified 2026-07-10, post hard-fork)

- Pages is **fully implemented and intact after the history reset**: CRUD +
  auth gating + SSE + git-commit in `routes/pages.ts`; arena subroutes + eight
  `page-arena-*` modules; org/project-partitioned `claxedo_page` with
  version/If-Match 409; Tiptap editor + board + tab chrome in claxedo-app.
  **No docs-v2 core work has started** (no `routes/docs.ts`, no `doc.sql.ts`).
- The Convex side (projects, project_memberships, projectRole max-of-roles,
  ensurePersonalOrg, webhook revocation) is implemented and **shared** — the
  new doc store reuses `authorizeProject` exactly as pages did.
- **Connections are DONE**: `@claxedo/connections` kit (registry, attempts,
  tokens, impls: google/notion/atlassian/github, route factory, test stores) +
  claxedo-server host + `connection.sql.ts` row + `/api/claxedo/integrations`
  mount + settings/connect-dialog UI. Published to npm as `connections@0.1.x`.
- Frontend has a working **contribution registry** (tab surfaces, content
  surfaces, commands, settings) — the docs-index tab and composer commands ride
  it; no new extension mechanism is needed.
- The Electron **browser tab webview** (`persist:agent-browser` partition)
  exists and is not subject to X-Frame-Options — external docs can be opened
  inside the app on desktop. Web builds have no webview (link-out only).
- Signed mode is deployed nowhere; loopback-local is the only mode real users
  have. The kit must therefore work loopback.

## Scope Boundaries

**In scope (v1):** core doc store rebuild; pages product deletion; Arena
re-point; the doc-collab kit with all three providers; publish / poll /
quick-resolve /
revision-round flows; docs-index tab; composer commands; desktop webview open.
(Connections framework was in scope and is now shipped.)

**Out of scope (v1), recorded in Deferred Work:** provider webhooks; Google
suggestion acceptance (API cannot); Notion resolved-thread history (API cannot
read them); multi-account per provider; @-mentioning docs in the composer; a
native comment-thread renderer panel; automatic foreign-edit merging; realtime
collaborative human editing of internal drafts (Yjs — retired with the pages
roadmap, not deferred); org-shared connections / executor.sh backend; arena
redesign.

## Product Design — the Loop

### 1. Draft (workshop)

- `/docs draft <title>` in the composer, "New Doc" in the docs tab, or any
  agent calling `doc_create`. Content is markdown; every save appends a
  revision with author provenance (user vs agent+session).
- Arena v2: launch N agents at one doc; they write through the same revision
  API (each wave commit = revision). Local store ⇒ no rate limits, instant
  reads of each other's changes.
- The in-app editor is a simple markdown editor (view of the head revision +
  revision history sidebar). It is deliberately modest — the thesis is that
  agents do most of the writing.

### 2. Publish (showroom)

- `/docs publish <provider>` or a button on the doc. The kit creates the
  external doc from the bound revision, records the publication (provider,
  external id, url, revision), and returns the link. User shares it in the
  provider's own UI. Reviewers never need Claxedo.
- Re-publish pushes the current head revision to the same external doc
  (blocked with confirmation if `foreign_edits` detected).

### 3. Feedback

- Humans comment in the provider. `/docs check-feedback` (or the skill run on
  demand / by the user's own scheduler) polls open comment counts across the
  registry; the docs tab shows per-doc counts and an attention badge.

### 4. Resolve

- `/docs resolve-feedback <doc>` starts an agent session **in the linked
  project's workspace** (grounding = ordinary file tools; nothing bespoke).
- Per open thread: locate the anchor (quoted text / block / inline marker) in
  the canonical markdown → investigate in the codebase (cite file paths) →
  classify:
  - **quick fix** → edit the external doc section, reply with what changed +
    citations, resolve the thread (or reply-marker where the API can't);
  - **answer-only** → reply with the grounded answer, resolve;
  - **big feedback** → collect into a revision round;
  - **ambiguous** → reply with a clarifying question; never guess-edit, never
    resolve.
- Revision round (when triggered): pull the collected feedback into a new
  internal drafting round (optionally Arena), produce revision N+1, re-publish,
  reply on each folded thread: "addressed in the new version, see <section>".
- Finish: sync publication state, post a summary in chat (N resolved, M
  replied-only, K folded into rev N+1, J need you).

**Failure modes (encoded in the skill):** external revision conflict → re-read,
re-anchor, retry once, else skip + report; anchor lost (doc edited since
comment) → ask commenter to re-anchor; token expired → abort with a reconnect
deep link (never half-finish); provider rate limits → threads processed
sequentially, adapter-level backoff (Notion ~3 rps); unknown Confluence macros
→ append-only fallback, never `replace_all`.

## UX Surfaces

- **Connecting a provider (SHIPPED):** Settings → Connections
  (`settings-connections.tsx` + `dialog-connect-integration.tsx`) over
  `/api/claxedo/integrations`. Docs work item: any docs tool invoked without a
  connection returns an actionable error containing a connect deep link;
  Google requires host env `CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID/SECRET`.
- **Composer:** slash commands via the existing popover (which already renders
  skill/mcp source badges): `/docs draft`, `/docs publish`, `/docs link <url>`
  (adopt an existing external doc), `/docs check-feedback`,
  `/docs resolve-feedback`. MCP tools remain agent-invocable in any session.
- **Docs index:** new `docs-index` tab type via `TabSurfaceContribution` +
  `ContentSurfaceContribution` (pattern: pages-index). Rows: title, lifecycle
  state, provider icon + link when published, open-comment count, last sync,
  actions (Open draft / Open external / Publish / Resolve feedback / Archive).
  `TabItem.attention` + count badge on new feedback.
- **Viewing comments:** desktop — "Open external" opens the provider's own doc
  UI (native comments) in the existing Electron browser tab; user signs into
  the provider once in that partition. Web builds — link out. Comment *data*
  additionally reaches the user through the resolve session's per-thread report
  and the docs-tab counts. No native comment renderer in v1.

## Connections Framework (IMPLEMENTED — reference)

Originally specified here; since built. Authoritative reference:
`docs/plans/2026-07-03-004-feat-connections-framework-plan.md`. Shape:

- **Kit** `@claxedo/connections` (`packages/claxedo-connections`): integration
  registry, attempt state machine, token service, reference impls
  (google, notion, atlassian, github), route factory, in-memory test stores.
- **Host** owns persistence (`storage/connection.sql.ts`), auth gates, mount
  (`/api/claxedo/integrations`), env reads, and which integrations register.
- **Model: connection vs capability** (shared with the WorkGraph inbox
  reframe; "do NOT build parallel auths"): a connection is an authenticated
  account link (google / notion / **atlassian site** / github); capabilities
  toggle per connection: `docs` (this plan), `work-source`, `channel`,
  `code-host`. One Atlassian connection serves Confluence docs AND Jira
  work-source.
- **What this plan still needs from it** (verify, don't assume):
  1. in-process access to the token service from the doc-collab kit (same
     server process — no route needed; LANE 0 pins how the host hands the
     service to sibling kits);
  2. capability metadata on connections (if not present, the docs kit
     filters by integration id — acceptable v1);
  3. Confluence/Notion `key`-method fallbacks per Locked Decision 18.
- **Evaluated and not adopted** (recorded for posterity): integrations.sh
  (spec registry only, no auth) and executor.sh (MIT MCP gateway; OAuth-app
  ownership undocumented; wouldn't replace the DocDestination layer). Revisit
  executor only if a hosted control plane wants org-shared connections.

## Technical Design

### Core drafting substrate (claxedo-server)

Schema (`packages/claxedo-server/src/storage/doc.sql.ts`, new migration wipes
pages + arena tables):

```text
claxedo_doc(
  id TEXT PK,                      -- crypto-random, non-enumerable
  org_id TEXT NOT NULL,            -- '__local__' loopback sentinel
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  head_revision_id TEXT,
  created_by TEXT, created_at, updated_at, archived_at,
  INDEX (org_id, project_id), INDEX (org_id, project_id, updated_at)
)
claxedo_doc_revision(
  id TEXT PK, doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,            -- monotonic per doc
  parent_revision_id TEXT,         -- concurrency guard: mismatch with head → 409
  content_md TEXT NOT NULL,
  author_kind TEXT NOT NULL,       -- 'user' | 'agent'
  author_id TEXT, session_id TEXT, note TEXT, created_at,
  UNIQUE (doc_id, seq)
)
claxedo_doc_publication(
  id TEXT PK, doc_id TEXT NOT NULL,
  destination TEXT NOT NULL,       -- 'google-docs' | 'notion' | 'confluence'
  external_id TEXT NOT NULL, url TEXT NOT NULL,
  published_revision_id TEXT NOT NULL,
  state TEXT NOT NULL,             -- 'in_sync' | 'behind' | 'foreign_edits'
  open_comment_count INTEGER, last_synced_at,
  last_resolution_session_id TEXT, created_at, updated_at,
  UNIQUE (doc_id, destination, external_id)
)
```

Routes (`packages/claxedo-server/src/routes/docs.ts`): CRUD + revisions +
publication metadata, gated exactly like pages were (`controlPlaneAuthContext`
+ `allowLoopbackLocal` + `authorizeProject`; scoped fetches only, cross-scope
404). Arena v2 subroutes re-pointed at `doc_id`/revisions
(`routes/docs-arena.ts`, minimal-change port of `pages-arena.ts` and the
`page-arena-*` modules).

### Doc-collab kit (`packages/claxedo-doc-collab/`)

Workspace kit package composed into claxedo-server (pattern:
`@claxedo/connections`; the name avoids `@claxedo/docs`, the docs site):

```text
packages/claxedo-doc-collab/
  src/index.ts                  # destination registry + publish/feedback/resolve service
  src/types.ts                  # DocDestination, capabilities, outcomes
  src/markdown.ts               # canonical markdown + section anchors
  src/destinations/{google-docs,notion,confluence}.ts
  src/capability-matrix.test.ts # the matrix, executable
packages/claxedo-server/src/doc-collab-host/  # host wiring: token service
                                              #   handle, publication store, mount
packages/claxedo-mcp/           # + doc_* tool registrations (call /docs routes)
skills/                         # resolve-doc-feedback + check-doc-feedback,
                                #   shipped first-party (LANE M pins pipeline)
```

Auth: the kit does NOT implement OAuth — it reads live access tokens from the
connections token service in-process. Provider HTTP happens only server-side;
agents, MCP processes, and clients never see tokens.

```ts
interface DocDestination {
  readonly id: "google-docs" | "notion" | "confluence"   // destination id
  readonly connection: "google" | "notion" | "atlassian" // which connection powers it
  capabilities(): DocCapabilities
  createDoc(i: { title: string; markdown: string; parent?: string }): Promise<DocRef>
  readDoc(ref: DocRef): Promise<{ title: string; markdown: string; sections: SectionAnchor[]; revision: string; url: string }>
  applyEdits(ref: DocRef, edits: Edit[], o: { expectedRevision: string }): Promise<{ revision: string }>
  listComments(ref: DocRef, f: { status: "open" | "all" }): Promise<CommentThread[]>
  replyToComment(ref: DocRef, commentId: string, body: string): Promise<void>
  resolveComment(ref: DocRef, commentId: string, replyBody?: string): Promise<"resolved" | "reply_marker" | "unsupported">
  share(ref: DocRef, i: { email?: string; role?: "reader" | "commenter" | "writer" }): Promise<"shared" | "url_only">
}
// Edit = { op: "replace_section" | "append_section" | "replace_all", anchor?, markdown }
```

MCP tools (added to the existing claxedo-mcp server; operate on internal doc
ids; explicit `outcome` fields; results are
raw data for the agent): `doc_create`, `doc_get`, `doc_edit` (internal
revision), `doc_list`, `doc_publish`, `doc_import_external` (foreign edits →
new revision), `doc_link`, `doc_comments_list`, `doc_comment_reply`,
`doc_comment_resolve`, `doc_share`, `doc_sync`, `doc_check_feedback`.

### Provider capability matrix

| Capability | Google Docs | Notion | Confluence Cloud |
|---|---|---|---|
| Create | `documents.create` | `pages.create` | content POST (storage format) |
| Edit | `batchUpdate` — index-based; **re-read indices immediately before every write**; guard `writeControl.requiredRevisionId` | block CRUD (cleanest section-edit fit) | full-body PUT with `version.number+1` |
| Read comments | Drive v3 `comments.list` (anchored, quoted content) | comments API — **unresolved threads only** | inline + footer comments REST |
| Reply | `replies.create` | yes | yes |
| Resolve | yes (`replies.create` `action: "resolve"`) | **no API resolve** → `reply_marker` (`✅ Resolved by Claxedo:` reply) | inline-comment resolve supported |
| Share | Drive `permissions.create` | **no sharing API** → `url_only` | restrictions API partial → `url_only` in v1 |
| Format bridge | structured ↔ markdown, near-lossless | blocks ↔ markdown, exotic blocks left untouched | storage-XHTML lossy on macros → **refuse `replace_all` when unknown macros present; append-only fallback** |

Verify at implementation time (APIs move): Notion comment-resolution and
webhook support; Google suggestion APIs. Upgrade the matrix + tests if changed.

## Open Questions

- How the doc-collab kit gets the connections token service in-process
  (direct kit import vs a handle the host passes in) — LANE 0 pins it.
- Which pipeline ships first-party skills (agent-hooks templates vs the
  extensions materializer) — LANE M pins it.
- Do the shipped google/notion/atlassian impls cover the `key`-method
  fallbacks of Locked Decision 18? Extend impls if not.
- Is `status-editor-dialog.tsx` pages-only? Grep consumers; delete only if sole
  consumer (LANE RF).
- Does anything besides pages consume workspace-runtime `git/snapshot`? Keep
  the endpoint regardless; confirm no dead claxedo-server callers remain after
  removal.
- Editor choice for the internal markdown surface (plain textarea+preview vs
  CodeMirror) — LANE U decides; Tiptap is retired either way.
- Google OAuth app verification timeline (calendar risk, human checkpoint);
  host env `CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID/SECRET` must be provisioned
  for the e2e gate (test-mode OAuth app acceptable).

## Phased Delivery — Execution: parallelize with agents & workflows

Written for parallel agent execution: each lane owns a disjoint file set in its
own worktree; an orchestrator merges in order and re-runs gates after each
merge. Use parallel subagents/Workflows for lane execution, research, and
verification; pipeline independent lanes, barrier only at merge points.

```text
LANE 0 → LANE D → { LANE RF, LANE A, LANE PG, LANE PN, LANE PC } → LANE M → LANE U
(LANE CX — connections — is COMPLETE; see Amendment)
```

- **LANE 0 — Contract** (serial, first): freeze `DocDestination` + `Edit` +
  outcome types, doc/revision/publication schema, MCP tool schemas; read the
  connections kit's token service and pin the in-process token seam.
  Deliverable: types + empty implementations compile repo-wide.
- **LANE D — Core store rebuild + server removal**: new `doc.sql.ts` +
  migration (wipes pages/arena tables), `routes/docs.ts` + `docs-arena.ts`
  (port), delete `routes/pages*.ts`, `page-store.ts`, `page-content.ts`,
  `page-arena-*.ts`, `storage/page.sql.ts`, `page-arena.sql.ts`, the `/pages`
  mount in `server.ts`; update `architecture.test.ts` /
  `architecture-ownership.ts`. Forbidden: touching `convex/`,
  `control-plane/authority.ts`, `packages/claxedo-connections/`.
- **LANE RF — Frontend removal + docs-index**: delete page-* components,
  tab-page*, pages-api.ts, page content renderers, page layout actions, Tiptap
  deps (grep consumers first); new `docs-index` tab + content surface reusing
  the list shell; untangle main.tsx / tour-controller /
  first-party-surfaces / review-workspace consumers.
- **LANE A — Arena re-point**: arena tables/routes/UI onto doc revisions.
  Minimal behavior change (Locked Decision 17).
- **LANE PG / PN / PC — providers** (fully parallel): one provider each behind
  the LANE-0 interface, consuming connections for tokens. TDD with golden-file
  edit tests (markdown → provider ops → markdown round-trip).
- **LANE M — tools + skills**: `doc_*` tool registrations in claxedo-mcp, both
  SKILL.md files shipped first-party. No packaging / materialization /
  marketplace work (native packaging decision — see Amendment).
- **LANE U — UX polish** (cuttable): composer commands, badges/attention,
  desktop webview "Open external", editor choice, publish/resolve buttons,
  connect deep links on missing-connection errors.

## Per-Phase Acceptance Criteria

**Phase 1 — Contract + core rebuild + removal (lanes 0, D, RF):**
- [ ] `grep -ri claxedo_page packages/` → zero production hits; pages routes,
      store, editor, board, tab chrome deleted; app builds and boots.
      Progress:
- [ ] New docs CRUD + revision log green: create → agent edit → user edit with
      stale `parent_revision_id` → 409; scoped fetches 404 cross-scope; loopback
      unsigned works.
      Progress:
- [ ] Arena runs one full wave against a docs-v2 doc.
      Progress:
- [ ] Token seam pinned: the doc-collab kit obtains live access tokens from
      the connections token service in-process; tokens never leave the server.
      Progress:

**Phase 2 — Google end-to-end (lane PG + M start):**
- [ ] Google connection completes via existing Connections UI (host env
      provisioned); the kit obtains a live token through the pinned seam.
      Progress:
- [ ] Live demo on a real Google Doc: `/docs draft` → `/docs publish` → human
      comments (manual) → `/docs resolve-feedback` edits the doc, replies with
      a code citation, resolves the thread, posts a chat summary.
      Progress:

**Phase 3 — Notion + Confluence (lanes PN, PC):**
- [ ] `capability-matrix.test.ts` green including degradation outcomes
      (`reply_marker`, `url_only`, macro append-only fallback).
      Progress:
- [ ] Live publish + reply-resolve demo on Notion (key method) and Confluence
      (key method).
      Progress:

**Phase 4 — Loop + UX (lanes M, U):**
- [ ] Revision round works: big feedback folded into revision N+1, re-published,
      threads answered with "addressed in new version".
      Progress:
- [ ] Docs tab: lifecycle states, comment counts, attention badge; "Resolve
      feedback" button starts a grounded session; desktop "Open external" opens
      the provider doc in the browser tab.
      Progress:
- [ ] `foreign_edits` detected on external change; re-publish blocked without
      confirmation; `doc_import_external` lands a new revision.
      Progress:

## Operating Rules (inherited)

- Read the relevant source before editing; plan-doc line numbers are hints,
  never addresses — grep for symbols.
- TDD on providers and the revision store: behavior-asserting tests first
  (golden-file edit round-trips, 409 paths, degradation outcomes).
- Delete parallel/dead implementations in the same lane — no coexisting
  pages+docs code after LANE D/RF merge.
- Make illegal states unrepresentable: outcome unions, lifecycle-derived state,
  branded ids; no destination HTTP outside `src/destinations/`.
- Secrets stay server-side; clients and MCP processes see short-lived access
  tokens stay inside claxedo-server; nothing secret in client or MCP state.
- Use parallel agents/Workflows per lane with disjoint file ownership; verify
  each slice before merging the next.

## Verification Loop

- Per-package: targeted vitest file lists (full claxedo-server suite hangs
  locally — known); `tsc` per touched package; `bun run test` in claxedo-app
  (needs `--conditions=browser`).
- Live-provider smoke: scripted create→publish→comment→resolve run per
  provider with human-supplied credentials (recorded; human checkpoint —
  cannot be fully agent-verified).
- UI: browser-use pass over the Docs tab and composer commands; desktop
  webview open verified manually. (Connections UI already shipped/verified.)
- Post-merge gates after each lane merge: grep gates (`claxedo_page`, pages
  routes), architecture ownership tests, typecheck (31/31 packages green is
  the post-fork baseline — don't regress).

## Quality Gates

- No destination HTTP outside `packages/claxedo-doc-collab/src/destinations/`.
- No refresh tokens outside the connections host.
- Every `DocDestination` capability gap returns a typed outcome — grep for
  silent catch/no-op paths in providers.
- Authz: cross-org/project fetches 404 (port the pages-auth test patterns to
  docs routes).
- `capability-matrix.test.ts` is the single source of truth for degradations;
  the PRD table and the skill prompts must agree with it.

## Definition of Done

- [ ] Pages product fully removed (server + frontend + deps); identity
      foundation diff-clean (`git diff convex/ control-plane/authority.ts`
      empty across all lanes).
      Progress:
- [ ] Docs v2 store live: markdown-canonical, revision log with provenance,
      409 concurrency, org/project scoping, loopback unsigned.
      Progress:
- [ ] Arena runs on docs v2.
      Progress:
- [x] Connections framework shipped (kit + host + UI) — done 2026-07-06/09,
      pre-dating this restoration; the doc-collab kit consumes it.
      Progress: implemented as @claxedo/connections; see Amendment.
- [ ] All three providers behind one interface; degradations explicit and
      tested; no ACL code anywhere in the kit.
      Progress:
- [ ] Full loop demoed end-to-end on Google (draft → publish → comment →
      resolve → summary), reply-resolve variants demoed on Notion and
      Confluence.
      Progress:
- [ ] Revision-round path demoed (feedback → rev N+1 → re-publish → threads
      answered).
      Progress:
- [ ] Docs tab + composer commands shipped; desktop webview open works.
      Progress:
- [ ] Deferred Work section below kept accurate; docs pointers updated.
      Progress:

## Deferred Work

Each item carries its corrected facts so future docs don't re-inherit errors:

- **Webhooks** (Drive watch channels expire; Notion webhook maturity unverified;
  Atlassian needs a Connect/Forge app) — reuse the claxedo-channels inbound
  pattern when a public endpoint exists.
- **Google suggestion acceptance** — API cannot accept suggestions; revisit
  only if Google ships it.
- **Multi-account per provider** — one credential per integration per scope
  in v1.
- **@-mention docs in composer**; **native comment-thread panel** (only if
  webview gaps demand it); **registry SSE** (v1 refetches).
- **Automatic foreign-edit merge** — v1 is explicit import; a real 3-way
  markdown merge is its own project.
- **Arena redesign** (agents-as-sessions coordination model) — own doc;
  Locked Decision 17 kept v1 to a re-point.
- **executor.sh as connections backend** — moot for local; revisit only for
  org-shared connections on a hosted control plane.

## Frozen Contracts

Changes to these after LANE 0 require updating this doc first: the
`DocDestination` interface + `Edit` + outcome unions; MCP tool names/schemas; the
`claxedo_doc*` table columns; the in-process token-service seam; the
lifecycle-state derivation rules.
