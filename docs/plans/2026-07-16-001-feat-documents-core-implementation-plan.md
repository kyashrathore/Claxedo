---
title: "Claxedo Documents Core — Technical Implementation Plan"
type: feat
date: 2026-07-16
status: complete
completed: 2026-07-17
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
inputs:
  - docs/brainstorms/2026-07-16-claxedo-documents-core-requirements.md
  - docs/plans/2026-07-15-001-fix-pages-filesystem-documents-plan.md
companion: docs/plans/2026-07-16-002-feat-documents-core-architecture-and-features.md
---

# Claxedo Documents Core — Technical Implementation Plan

## Point of View

This plan turns the Documents core requirements (R1–R29 in the brainstorm) and
the filesystem-authority product contract (2026-07-15 plan) into ordered,
verifiable implementation units. It is a clean replacement: Pages is
pre-release with one development user; there is **no migration, legacy read
path, dual write, or compatibility period**. The development database may be
reset and the target schema installed directly.

One sentence of architecture: a **document index row locates exactly one
authoritative Markdown file**; the **human editor** reads and writes that file
through a `DocumentWorkspace` service (Markdown + opaque version tokens +
compare-and-swap saves); **agents are ordinary collaborators** — the file is
reachable in their session's filesystem and they edit it with their normal
harness tools, no special pipeline, lock, or bracket; the editor stays
truthful by **reacting to external changes** (refresh when clean, conflict
when dirty); everything else (index UI, diff, version history, WorkGraph
handoff, hosted sync) consumes those contracts.

### Owner decision 2026-07-16 — agent model simplification

The brainstorm's agent-editing requirements R19–R25 described a bracketed
agent operation (flush gate, document read-only lock, operation copy,
conditional apply, per-operation checkpoints and terminal-outcome handling).
**The owner has superseded that model**: agents work however their harness
works, directly on the file. The mapping:

| Brainstorm | Status in this plan |
| --- | --- |
| R19 (normal session, document as context) | Kept, strengthened: `/docs` mention + MCP discovery (D8) |
| R20 (conflict-free flush before agent starts) | Replaced by eager flush-on-blur/close (D6); no start gate exists |
| R21 (document read-only while agent edits) | **Dropped.** No locks. Editor reactivity + CAS instead (D9) |
| R22 (operation copy + conditional apply) | **Dropped as a product concept.** Survives only as hosted/remote *sync mechanics* (hydrate + ETag write-back, D11/D12) |
| R23 (terminal-outcome handling, unlock, diff) | Dropped with the operation concept; "what changed" = changed-on-disk diff, Git diff, snapshots (D9) |
| R24 (pre-apply recovery checkpoint) | Replaced by automatic bounded snapshots for managed docs; Git for repository docs (D1/D9) |
| R25 (out-of-contract output → source mode, keep undo) | Kept, generalized: any external change re-runs the detector on refresh; snapshots cover restore (D9) |

### Grounding facts this plan is built on (verified 2026-07-16)

- Storage today: `claxedo_page.content` holds stringified Tiptap JSON in SQLite
  via Drizzle (`packages/claxedo-server/src/storage/page.sql.ts`), with a
  hand-rolled 420-line Markdown⇄Tiptap converter
  (`packages/claxedo-server/src/routes/page-content.ts`). Both are deleted by
  this plan.
- The `claxedo_document`/`claxedo_document_revision` tables
  (`packages/claxedo-server/src/storage/doc.sql.ts`) are a **one-way derived
  mirror** of page content, not an independent authority. Their only live
  consumer is the WorkGraph handoff locator
  (`packages/claxedo-app/src/features/documents/actions/doc-work-action.ts`,
  `durableDocumentRevisionForPage` → `{projectId, documentId, revisionId}`).
  D10 re-points that seam before the tables die.
- Optimistic concurrency already exists twice and both patterns are reused:
  `If-Match` version CAS on pages (`page-store.ts` 428–505) and
  `expected:{baseCommit, baseBlobSha}` git commits with `GitSourceConflictError`
  (`packages/workspace-runtime/src/workspace-files/git-source.ts`).
- Atomic write utilities exist: temp-file+rename
  (`packages/agent-extensions/src/fs-safe.ts:9`) and the stronger
  fsync-file-then-fsync-dir variant
  (`packages/claxedo-server/src/credentials/local.ts:33`).
- Durable local root: `CLAXEDO_DATA_DIR ?? ~/.claxedo`
  (`packages/agent-sdk-runtime/src/paths.ts:4`), already consumed by
  claxedo-server for credentials. There is **no** single `CLAXEDO_HOME`; KTD2
  picks this root.
- Unsigned local mode is a loopback-only guard
  (`packages/claxedo-server/src/control-plane/deployment-mode.ts:224`) with
  `orgId = "__local__"`; pages routes already branch on it.
- The relay already models the cloud→local direction
  (`{access:"user-hosted", backing:"local-worktree"}`,
  `packages/workspace-relay/src/auth.ts:12`) with JWT capability tokens, but no
  per-document capability or installation credential exists yet.
- Session file APIs pin paths to the workspace root
  (`resolveWorkspacePath`, `packages/workspace-runtime/src/routes/
  session-env.ts`) — local managed documents live *outside* any workspace, so
  agent access needs an explicit grant (Q2).
- `@tiptap/markdown` exists on npm at **exactly 3.23.4**, the repo's pinned
  Tiptap version (verified against the registry). Its *fidelity* is unproven —
  gated by D5.
- Current editor defects the replacement must not reproduce (all confirmed in
  `packages/claxedo-app/src/features/documents/editor/page-editor.tsx`):
  independent 800ms/1500ms title/content debounce timers racing one version
  counter; `.catch(() => {})` on both save paths; `onCleanup` drops pending
  edits without flushing; title saves never show saving state; the index list
  ships full content bodies; one 1001-line component owns persistence, agent
  state, git state, Arena, TOC, status, and layout.
- Today's "Ask agent" injects document text truncated at 14,000 chars with a
  "no tools" system prompt (`page-editor-model.ts:117-134`). It is deleted;
  the replacement is `/docs` mentions + agents' own file tools (D8).
- "Files SDK" named in the 2026-07-15 plan **does not exist** as a dependency.
  This plan defines the `DocumentWorkspace` port ourselves (KTD1) and treats
  any external SDK as a possible adapter behind it, never as the contract.

### Corrections this plan encodes (deltas from the input docs)

1. R19–R25 superseded per the owner decision table above.
2. Selection-scoped quick actions (improve/fix/shorten) are **retained** as
   editor-local transforms (KTD8) — they were silently orphaned by the
   requirements docs.
3. WorkGraph work-source continuity is an explicit unit (D10); exactness moves
   into the ingest MCP call (server-side content-hash snapshot), not a UI
   pipeline.
4. Repository-origin documents get a **serialization-churn quality bar**
   (EC-F7): first rich edit must not rewrite whole-file formatting.
5. The 2026-07-15 plan's "second document/revision system advances content
   independently" claim is corrected: the revision tables are a derived
   one-way mirror; the real defects are the JSON-in-DB authority and the
   lossy import/export loop.

## Key Technical Decisions

- **KTD1 — One port, two write disciplines.** A `DocumentWorkspace` interface
  owned by `packages/claxedo-server` serves the *human editor and product
  features* (index, snapshots, move, WorkGraph ingest). Local managed backend,
  repository backend, and hosted managed backend implement it behind one
  conformance suite. **Agents are deliberately outside this port** — they use
  harness file tools on the same file; the service detects their writes
  instead of mediating them.
- **KTD2 — Managed root = `CLAXEDO_DATA_DIR ?? ~/.claxedo`.** Layout:
  `documents/<project-id>/<document-id>/<slug>.md` for canonical files,
  `document-history/<document-id>/<ulid>.md` + `<ulid>.json` (metadata
  sidecar) for immutable, service-owned snapshots. History lives *outside*
  the agent-reachable documents directory. Physical file name is fixed at
  creation; renames change `display_name` only (kills the
  rename/case-collision/NFD class of bugs, EC-A group).
- **KTD3 — Opaque version token = content hash + filesystem evidence.**
  `{sha256, size, mtimeMs}` serialized opaquely. Compare-by-hash decides
  conflicts (restart-safe, clock-skew-immune, agent-edit-aware); size/mtime
  is cheap staleness evidence only. Every editor write: verify expected token
  → write temp file in same directory → fsync file → rename → fsync dir (the
  `credentials/local.ts` recipe). Hosted backend maps the token to ETag
  behind the same opaque type.
- **KTD4 — No locks; coexistence = CAS + reactivity.** There is no mutation
  slot, no read-only mode, no agent bracket. The editor's CAS save is the
  only write-safety mechanism, and it is sufficient: whoever saves second
  onto a changed file gets a truthful conflict, and the editor additionally
  *reacts* to external changes (refresh when clean, conflict when dirty)
  so races are rare in practice and honest when they happen.
- **KTD5 — Markdown is the wire and storage format everywhere.** Tiptap JSON
  never crosses the persistence API. The editor adopts
  `@tiptap/markdown@3.23.4`; the server-side `page-content.ts` converter and
  the client `parsePageContent` JSON path are deleted. The shared
  `@/ui/rich-text` (markdown-it + prosemirror-markdown) stays for small fields
  (stream descriptions) and is out of scope; consolidation is a follow-up.
- **KTD6 — Rich-mode eligibility = round-trip proof, at open and on every
  external refresh.** A document renders rich only if
  `serialize(parse(text))` is byte-identical *after* the documented
  normalization (see D5) and contains only supported constructs. Anything
  else renders source mode with the reason surfaced. YAML frontmatter is
  preserved as an opaque prefix block. The detector never mutates the file.
- **KTD7 — Agent access = make the document an ordinary file, then get out of
  the way.** Repository docs are already in the workspace. Local managed docs
  are edited at their canonical path via an explicit session grant for the
  project's documents directory (Q2). Hosted/remote docs are hydrated
  per-document into the session filesystem with conditional write-back
  (KTD10). No agent-specific write API exists.
- **KTD8 — Two doors into documents from a session, plus inline quick
  actions.** (a) `/docs` in the composer: picker over index metadata, inserts
  a document mention (display name + resolved path + id) and triggers
  hydration when the session is remote. (b) claxedo-mcp tools:
  `documents_list` (metadata) and `documents_open(id|name)` (resolve/hydrate
  → path) for agent-driven discovery. (c) Selection quick actions remain
  editor-local prompt transforms: accepted text becomes a normal human edit
  that autosaves — they never touch the file directly.
- **KTD9 — External-change reactivity is a first-class service feature.** The
  server watches *open* documents (registration follows editor open/close),
  emits `document.changed` with a reason, and the editor refreshes in place
  when clean or enters the standard conflict recovery when dirty.
  Correctness never depends on the watcher — the save-time CAS is the
  backstop; the watcher buys liveness ("watch the agent edit") and degrades
  to refresh-on-focus where watching is unavailable.
- **KTD10 — Hosted/remote sync = per-document hydration manifest +
  conditional write-back.** Hydrate downloads exactly one object at its
  current version to a stable in-session path and records
  `{documentId, path, baseVersion}`. Write-back (debounced watcher on
  hydrated paths + end-of-turn sweep) uploads the whole file with
  if-match on the recorded version; success advances the manifest and emits
  `document.changed`; a mismatch preserves both sides and surfaces the
  standard conflict. Discovery is always the index API — nothing ever lists
  or clones the document root into a VM.
- **KTD11 — Safety net = Git for repository docs, automatic bounded snapshots
  for managed docs.** The service snapshots a managed document around its own
  writes and at detected external-change boundaries (debounced, bounded,
  GC'd with pins). "Restore version" is an explicit CAS write of a snapshot's
  content. There are no operation checkpoints because there are no
  operations.
- **KTD12 — Index is metadata-only.** The list API returns summaries; content
  is fetched only by the open-document read. The index record is the
  validated union from the 2026-07-15 plan (origin `managed|repository`,
  placement `local|hosted`, per-origin locator fields, `status`,
  `session_id`, `archived_at`, `last_known_file_version`).
- **KTD13 — Keep surface identity, change the product name only in strings.**
  Route shape `/page/<id>`, tab surface types `page`/`pages-index`, and deep
  links stay; user-visible strings say "Documents". Statuses
  (`claxedo_page_status` + transition validator) carry over as index
  metadata.
- **KTD14 — Hosted mode ships behind the same port, after local is proven.**
  Nothing in D1–D10 may leak local-only assumptions through the port
  (enforced by port-level conformance tests, mirroring the workgraph
  SQLite/Convex conformance pattern).

## High-Level Technical Design

### Component ownership

| Component | Package | New/Changed |
| --- | --- | --- |
| `DocumentWorkspace` port + local managed backend + version tokens + snapshots | `packages/claxedo-server/src/documents/` | New |
| Repository backend (git snapshot/commit adapter) | `packages/claxedo-server/src/documents/repository.ts` | New, wraps existing `workspace-runtime` git-source routes |
| Open-document watcher + `document.changed` events | `packages/claxedo-server/src/documents/watch.ts` | New |
| Index schema + store | `packages/claxedo-server/src/storage/document-index.sql.ts`, `.../documents/index-store.ts` | New; replaces `page.sql.ts`, `page-store.ts` |
| HTTP routes `/documents/*` (+ SSE) | `packages/claxedo-server/src/routes/documents.ts` | New; replaces `pages.ts` |
| Markdown contract: fixtures, detector, normalization spec | `packages/claxedo-app/src/features/documents/markdown/` | New |
| Persistence controller (headless) | `packages/claxedo-app/src/features/documents/state/persistence-controller.ts` | New |
| Editor: rich mode (`@tiptap/markdown`), source mode, save/conflict/recovery UI, external-change reactivity, version history | `packages/claxedo-app/src/features/documents/editor/` | Rewrite of `page-editor.tsx` into ≤300-line composition + owned children |
| `/docs` composer mention + document grants | claxedo-app composer integration; session grant plumbing per Q2 | New |
| MCP tools `documents_list` / `documents_open`; WorkGraph ingest snapshot | `packages/claxedo-mcp`, `packages/claxedo-server` | New/Changed |
| Hydration manifest + write-back sync | session runtime (workspace-runtime / agent-sdk-runtime seam per Q15) | New (hosted/remote only) |
| Deletions | `page-content.ts`, `doc.sql.ts`, `doc-store.ts`, `routes/docs.ts`, from-repo import, export-from-DB, `page-editor-ai.ts` whole-doc path | Deleted (D13) |

### Placement and layering map

Every new module has exactly one home, chosen to match the repo's existing
layer conventions — nothing lands "here and there". A reviewer agent checks
each unit's diff against this map and the import-graph guards; a file outside
its layer is a finding, not a style nit.

**claxedo-server** (layers enforced by `architecture.test.ts` import-graph
guards and the `route-ownership.ts` / `architecture-ownership.ts` registries):

| Module | Home | Pattern it follows |
| --- | --- | --- |
| `DocumentWorkspace` port, backends, versions, history, watch, hydration contracts | `src/documents/` | Domain services as src-root modules (`document-host/`, `workgraph-host/`, `credentials/`). SQLite/fs coupling is allowed here as a Worker-forbidden local adapter; the hosted-managed backend must stay Worker-safe or split its adapter the way `workgraph-host` splits Convex — verified against the import-graph guard. |
| HTTP surface | `src/routes/documents.ts` | Thin route adapter only (scope resolution → service call → typed error), per the architecture-ownership "Unit 5" verdicts that keep SQLite-coupled route adapters under `routes/`. **No business logic in routes.** |
| Index table defs | `src/storage/document-index.sql.ts` | Drizzle defs live in `storage/` (`page.sql.ts` precedent); migration under `storage/claxedo-migration/<ts>_documents_reset/`. |
| Registry updates | `route-ownership.ts` (replace `/pages` and `/api/claxedo/docs` entries), `architecture-ownership.ts` (remove pages rows, add documents verdicts) | Mandatory, not optional — the architecture guard tests fail otherwise. |
| Mounting | `server.ts` **and** `hosted-app.ts` | Both compositions, preserving the unsigned-local gate discipline. |

**claxedo-mcp:** `src/documents-tools.ts` (+ test), following the flat
`<domain>-tools.ts` convention (`workgraph-tools.ts`, `browser-tools.ts`),
registered through the same `tool-policy.ts` path.

**claxedo-app** (feature-module layout; `agents-md.guard` requires the
feature `AGENTS.md` to describe the layout; debt-ratchet pins apply):

| Module | Home | Rule |
| --- | --- | --- |
| HTTP client | `features/documents/data/documents-api.ts` | `data/` = wire clients only (existing shape). |
| Persistence controller, recovery drafts | `features/documents/state/` | Headless state, no DOM imports (workgraph's `change-sync.ts` precedent for feature-local sync logic). |
| Markdown contract, detector, fixtures | `features/documents/markdown/` | Pure module; no fetch, no editor imports. |
| Editor components | `features/documents/editor/` | UI only — no persistence timers, no fetch; consumes the controller. |
| Cross-feature actions | `features/documents/actions/` | `doc-work-action.ts` precedent (honest-unavailability doctrine). |
| `/docs` picker exposure | `features/documents/app-ports.ts` → consumed by the session feature's composer | Features never deep-import each other; cross-feature flows go through ports/integrations (existing `app-ports.ts` seam; composer integration point per Q13). |
| Surface wiring | `app/integrations/first-party-content-surfaces.tsx`, workbench `state/{orchestration,route-intent,surface-route,types}.ts` | Updated in place; surface ids stay `page`/`pages-index` per KTD13. |

**workspace-runtime / agent-sdk-runtime:** the Q2 session grant lands beside
`resolveWorkspacePath` (path authority lives in workspace-runtime's
target/session-env today). The hydration write-back loop's owner is fixed by
the Q14 ADR (candidates: workspace-runtime session env — `materializeCodexAuth`
precedent — or a VM sidecar); it is explicitly **not** claxedo-app's and
**not** the MCP layer's job.

### The port (target shape, refined in D1)

```text
resolve(entry) -> DocumentHandle                    // authorization + path pinning
read(handle) -> { markdown, version, modifiedAt }
write(handle, { markdown, expectedVersion, actor }) -> WriteResult | VersionConflict
watch(handle) / unwatch(handle)                     // open-document registration
snapshot(handle, { reason, actor }) -> SnapshotRef  // immutable, content-hash identified
listSnapshots(handle) -> SnapshotRef[]
restore(handle, snapshotRef, { expectedVersion }) -> WriteResult
archive(entry) / restore(entry) / moveToRepository(handle, destination)
```

All paths resolve below the managed root or the authorized repository root;
symlinks are accepted only when their realpath stays inside that root (reuse
the `resolveWorkspacePath` inside/realpath discipline).

### External-change reactivity (KTD9, normative)

```text
file changed on disk (agent tools, git checkout, external editor, write-back)
 → watcher fires (or focus/poll fallback) → hash compared to last-known
 → SSE document.changed {id, reason, version}
 → editor:
     clean  → reread → re-run detector → refresh in place (rich or source)
     dirty  → conflicted: draft frozen; compare / reload / save-as-copy /
              confirmed overwrite
 → managed docs: service records a bounded snapshot at the change boundary
```

### Agent access flow (KTD7/KTD8, normative)

```text
/docs picked (or agent calls documents_open)
 → resolve index entry
 → placement local:  path = canonical file; ensure session grant covers it (Q2)
 → placement hosted/remote: hydrate one object at current version to
   .claxedo/docs/<document-id>/<slug>.md; record {id, path, baseVersion}
 → mention/tool result carries {display_name, path, document_id}
 → agent reads/edits with ordinary tools — no Claxedo involvement
 → local: watcher sees the write directly
 → hosted/remote: write-back uploads whole file if-match baseVersion;
   mismatch ⇒ both sides preserved + conflict surfaced; success ⇒ manifest
   advances + document.changed
```

### Persistence controller states (D6, normative)

`idle → dirty → saving → (saved | failed | conflicted)`; `flush()` promotes
dirty→saving immediately and resolves when settled; title and body are one
queue with one expected-version; `failed` retries with capped backoff and is
always visibly actionable; `conflicted` freezes autosave, keeps the draft, and
exposes compare / reload / save-as-copy / confirmed-overwrite. Flush runs on
unmount, tab close, **editor blur** (so switching to the chat composer lands
the latest keystrokes before an agent reads the file), and every
content-consuming action (export, commit, WorkGraph ingest, move).

## Unknowns Register

Every unknown that could change the design, with resolution method and the
default that holds if resolution is inconclusive. A unit may not be marked
done while an unknown it depends on is open.

| # | Unknown | Why it matters | Resolution | Blocks | Default |
|---|---|---|---|---|---|
| Q1 | `@tiptap/markdown@3.23.4` round-trip fidelity for GFM tables, task lists, hard breaks, code fences w/ language, autolinks, nested lists, and its extension API for the custom Mermaid block | KTD5/KTD6 rest on it; poor fidelity pushes most files to source mode | D5 fixture harness, first task of the unit | D5, D7 | Ship with a narrower supported subset (source mode is the safety net) |
| Q2 | How a local session gets file-tool access to the managed documents directory (outside every workspace root; session APIs pin to the root) | KTD7 for local managed docs — the zero-copy promise | Spike at D8 start: trace tool sandboxing for local sessions; if pinned, design the additional-root grant | D8 | Add a scoped "additional roots" allowlist to the session env, granted per project documents dir; fallback = local hydration (copy + write-back), same mechanics as hosted |
| Q3 | Single-writer guarantee: can two claxedo-server processes (desktop app + manually started dev server) own the same data dir concurrently? | Editor CAS is safe cross-process, but SQLite index + watcher + snapshot GC assume one owner | Inspect startup/ownership (plan-doc broken behavior #1) in D3; test double-start | D1, D3 | Data-dir lockfile with stale detection; second process refuses or goes read-only |
| Q4 | How `project_id` is resolved in unsigned local mode (directory-derived? fixed?) and whether it is stable across restarts | Managed layout keys on project-id (KTD2); an unstable id strands documents | Trace pages' local scope resolution in D2 | D2 | Persist a project registry in the index DB mapping directory → generated stable project-id |
| Q5 | Frontmatter round-trip: can the opaque-prefix approach preserve *all* frontmatter byte-exactly, including CRLF and `---` edge forms? | Most repo docs here carry frontmatter; mangling it is a hard fail | D5 fixtures include every frontmatter form in `docs/**` | D5 | Files whose frontmatter can't be provably preserved open in source mode |
| Q6 | Reusable diff component for the changed-on-disk view (session diffs may already render one) | Avoids a bespoke diff renderer | Inventory sweep at D9 start | D9 | Unified text diff with the app's existing code-block styling |
| Q7 | Arena writes: does Arena ever write page content, or only inject context? | Determines whether Arena adaptation is read-only re-pointing (cheap) or needs design | Grep/trace `page-arena-*` in D13 | D13 | Arena reads via `read(handle)`; any write path it turns out to have is disabled pending its own design |
| Q8 | Hosted blob backend choice (R2 vs S3 vs existing infra) and its version primitive (ETag vs generation) | D11 adapter design | Spike + ADR at D11 start | D11 | R2 with ETag-as-token; port conformance suite is the acceptance bar |
| Q9 | File-watching strategy per platform (fs.watch vs chokidar vs poll) and its reliability on macOS/Linux for the open-doc watcher | KTD9 liveness; watcher bugs must not corrupt anything | D9 spike; watch only open documents | D9 | chokidar on open docs; degrade to refresh-on-focus + save-time CAS (correctness never depends on the watcher) |
| Q10 | SSE fan-out is in-process (module-level listener map today) — is single-instance acceptable for first hosted deploy? | Hosted multi-instance would silently drop invalidations | Confirm hosted topology in D11 | D11 | Accept single-instance; document; clients also refetch on focus + reconnect |
| Q11 | Content/size limits: max document size for rich mode, API body limit, editor perf ceiling | EC-A7; unbounded files hang Tiptap | Perf probe in D7 with 100KB/500KB/2MB fixtures | D5, D7 | 2MB hard API limit; >512KB opens source mode |
| Q12 | Does `moveToRepository` need to be transactional across two backends (managed file → repo commit → index flip)? Crash between steps? | R27 correctness | Design in D10; ordered idempotent steps + journal | D10 | Order: write repo file → verify → flip index → archive managed file; a crash leaves both files, never zero; reopen reconciles by journal |
| Q13 | `/docs` composer integration point: where mentions/slash commands plug into the session composer, and what a document mention renders as in the transcript | D8 UX seam | Inventory the composer's existing mention/command extension points at D8 start | D8 | Plain-text injection of "document: <name> at <path> (id)" if no mention framework exists; upgrade later |
| Q14 | Which sync loop owns hosted write-back: workspace-runtime session env, VM sidecar, or agent-sdk-runtime hook — and its trigger (watcher vs end-of-turn sweep vs both) | KTD10 placement; must run where the VM filesystem is visible and survive agent crashes | Design at D11 start with the sandbox-manager owner | D11, D12 | Debounced watcher in the session runtime + end-of-turn sweep as fallback; manifest persisted beside the session |
| Q15 | e2e infrastructure: which Playwright harness covers the editor, and does the vision-review loop exist as tooling or convention only? | Verification contract | Check `packages/claxedo-app/e2e` in D14 | D14 | Follow the verification doctrine in `docs/plans/2026-07-10-001-refactor-e2e-20-spec-consolidation-plan.md` |

## Edge Case Catalog

Each case is mandatory: it maps to an owning unit and must appear as a test or
an explicitly asserted behavior before that unit is done.

### A. Files and content (owner: D1, D5)

- **EC-A1** UTF-8 BOM: preserved byte-exactly; BOM presence does not break the
  detector; rich mode strips nothing.
- **EC-A2** CRLF line endings: file opens in source mode unless round-trip
  preserves CRLF exactly (default: CRLF ⇒ source mode).
- **EC-A3** Unicode normalization: content is never NFC/NFD-normalized; file
  *names* are ASCII slugs by construction (KTD2) so macOS NFD is moot.
- **EC-A4** Invalid UTF-8 / NUL bytes (including written by an agent): read
  fails typed (`document_not_text`); index shows exceptional state; never
  opens an editor; latest valid snapshot remains restorable.
- **EC-A5** Empty and whitespace-only files: open rich (empty doc), round-trip
  to identical bytes; saving an empty doc writes zero-length content, not `\n`.
- **EC-A6** Missing trailing newline: preserved as-is through round-trip.
- **EC-A7** Oversized file (>limit, Q11): source mode above soft limit; typed
  rejection above hard limit; never a hang.
- **EC-A8** Symlinked document path: allowed iff realpath stays inside the
  authorized root; else typed rejection (no traversal).
- **EC-A9** Permission denied / read-only filesystem: read and write surface
  typed errors; draft preserved; retry visible.
- **EC-A10** Disk full / fsync failure mid-write: temp file removed
  best-effort; authoritative file untouched (atomicity); save state `failed`.
- **EC-A11** Managed document file deleted on disk (by anyone, agent
  included): open/refresh shows missing-file recovery, offering
  restore-from-latest-snapshot; the index row survives deletion of its file.
- **EC-A12** Case-insensitive filesystem collisions: impossible by
  construction — physical names are `<document-id>/<slug>.md` with unique ids.

### B. Concurrency and persistence (owner: D6, D3, D9)

- **EC-B1** Rapid alternating title/body edits: one queue, one version, no
  self-conflict (regression test against the current dual-timer bug).
- **EC-B2** Same document in two tabs of one app: the stale tab's save gets
  `conflicted` with the recovery flow — and with reactivity on, the clean
  second tab refreshes instead of conflicting.
- **EC-B3** Editor dirty while an agent saves the same file: editor's next
  save CAS-conflicts truthfully; recovery shows the agent's version and the
  human draft; neither is lost.
- **EC-B4** Save during in-flight save: coalesced by the controller;
  responses applied in order; no version leapfrog.
- **EC-B5** Server restart mid-edit: version tokens are content-derived, so
  the next save after reconnect succeeds or conflicts truthfully — never
  fails on a counter that reset.
- **EC-B6** SSE stream dies: client reconnects with backoff and refetches
  once on reconnect (events are invalidation hints, not a ledger).
- **EC-B7** Close/unmount with pending edits: `flush()` runs; a failed flush
  surfaces a blocking confirm (draft also mirrored to browser-local recovery
  storage until the next successful save).
- **EC-B8** Watcher misses an event (platform flake): correctness holds via
  save-time CAS; refresh-on-focus recovers liveness; a named test simulates
  a dead watcher.
- **EC-B9** Double-start of the server (Q3): second process must not corrupt;
  lockfile or ownership refusal, tested.
- **EC-B10** Rapid agent writes (multiple saves per second): SSE/reread
  debounced; editor refresh is coalesced and never interleaves a stale
  render between newer ones.

### C. Repository documents (owner: D4)

- **EC-C1** File deleted externally: open → recovery state offering
  re-locate, restore from last snapshot (as new file), or archive the entry.
- **EC-C2** File moved/renamed: same recovery state; re-locate updates
  `repository_relative_path` with an expected-version check.
- **EC-C3** Branch switch changes content under an open editor: clean editor
  refreshes to the new content; dirty editor conflicts with recovery.
- **EC-C4** Merge-conflict markers in the file: still text — detector sends
  it to source mode (markers are not valid GFM round-trip).
- **EC-C5** Add-to-Documents on an already-indexed path: dedupe — return the
  existing entry, never a second row for one file.
- **EC-C6** Add-to-Documents path outside any authorized workspace root:
  typed rejection (no traversal, no absolute paths).
- **EC-C7** Repository/workspace deleted after indexing: entry shows
  unavailable state with archive/re-locate actions; opening never blanks.
- **EC-C8** Git snapshot dirty/untracked conflicts: existing 409
  `git_source_conflict` semantics surface as the document conflict state.
- **EC-C9** Commit races (`base_commit` moved): existing expected-commit
  conflict path; document remains editable; draft preserved.

### D. Agents as external writers (owner: D8, D9, D11)

- **EC-D1** Agent edits while no editor is open: nothing special happens —
  the file changes; the index row's modified time updates on next
  observation; a snapshot is taken at the next change-boundary observation
  for managed docs.
- **EC-D2** Agent writes out-of-contract Markdown while the editor is open
  rich: refresh re-runs the detector and lands in labeled source mode with
  the reason; the boundary snapshot keeps the previous version restorable.
- **EC-D3** Agent deletes or renames the canonical file: EC-A11/EC-C1
  recovery states apply; index identity survives.
- **EC-D4** Agent writes byte-identical content: hash unchanged ⇒ no event,
  no snapshot, no refresh churn.
- **EC-D5** `/docs` picked in a session whose placement can't reach the doc
  (e.g. remote session, unreachable local app): the mention fails closed
  with a typed reason; no path is fabricated.
- **EC-D6** `documents_open` on an archived or missing document: typed
  honest-unavailable result; the tool never invents a path.
- **EC-D7** Hosted write-back if-match mismatch (browser edited meanwhile):
  VM copy preserved, manifest entry conflicted, editor/index show conflict;
  neither side overwritten. Resolution is a human action.
- **EC-D8** VM dies with unsynced edits: blob store holds last written
  version; the manifest dies with the VM; nothing corrupts. (Known loss
  window = write-back debounce; stated, not hidden.)
- **EC-D9** Hydrated path edited after the manifest conflicted: write-back
  stays parked for that doc until the conflict is resolved; subsequent
  syncs resume from a fresh hydrate.
- **EC-D10** Two sessions hydrate the same hosted doc: both work; write-back
  CAS serializes them; the loser's manifest conflicts (same as EC-D7).
- **EC-D11** Local grant scope (Q2): a session granted one project's
  documents dir cannot read another project's docs through it; traversal
  and symlink escape rejected — named negative tests.

### E. Index and lifecycle (owner: D2, D3, D10)

- **EC-E1** Deep link to a missing/archived id: explicit not-found /
  archived state with restore action; never a blank editor.
- **EC-E2** Duplicate titles: allowed (identity is id), tested.
- **EC-E3** Archive with pending edits: flush first; archive is metadata-only
  and keeps the file; restore reopens it.
- **EC-E4** Managed document "delete": milestone one has archive only; a
  purge action, if exposed, moves the file into history rather than
  unlinking.
- **EC-E5** History GC vs WorkGraph references: snapshots referenced by a
  work-source locator are pinned; GC honors the recovery window *and* pins.
- **EC-E6** `moveToRepository` crash windows (Q12): journaled, idempotent,
  resumable; at no point are there zero copies of the content.
- **EC-E7** Two projects claiming one repo path (multi-root): entries are
  project-scoped; dedupe (EC-C5) is per project; cross-project duplication
  is allowed and displayed with its project label.

### F. Mode transitions and fidelity (owner: D5, D7)

- **EC-F1** Detector false negative discovered post-open: the first-mutation
  serialization gate means an unedited open never rewrites; the D5 fixture
  corpus must include adversarial cases (reference links, setext headings,
  HTML blocks, footnotes, math, liquid tags, MDX-ish syntax) with zero known
  false negatives before repo files are rich-eligible.
- **EC-F2** Source → rich: requires re-running the detector on current bytes
  plus an explicit user action; never automatic.
- **EC-F3** Editing in source mode is plain-text editing with the same
  controller, autosave, conflict, and reactivity contracts.
- **EC-F4** Mermaid blocks: the existing custom node must serialize to fenced
  ` ```mermaid ` blocks round-trip (Q1 fixture).
- **EC-F5** Frontmatter (Q5): byte-preserved opaque prefix in rich mode or
  source-mode fallback; never reordered/requoted.
- **EC-F6** Normalization scope on first mutation: documented and
  fixture-pinned (e.g. list markers, emphasis delimiters); anything outside
  the documented set failing byte-stability is a D5 bug.
- **EC-F7** Repository-doc churn bar: for a one-paragraph edit in a
  representative repo doc, the saved diff touches only that region (plus
  documented normalization); asserted in D5's fixture suite with real files
  from `docs/**`.

## Cleanup Inventory — nothing Pages-stale remains

Enumerated from the tree on 2026-07-16 (not from memory). Every row has a
disposition and an owning unit; D13 is done only when this table is empty of
pending rows. Three dispositions: **DELETE** (remove file + its tests),
**REPLACE** (new-named successor per the placement map; old file deleted),
**ADAPT** (updated in place to the new contracts).

### claxedo-server

| Artifact | Disposition | Unit |
| --- | --- | --- |
| `routes/pages.ts`, `routes/pages.test.ts` | DELETE (successor: `routes/documents.ts`) | D13 |
| `routes/pages-auth.test.ts`, `routes/pages-git.test.ts` | REPLACE — the auth-matrix and git-guard *coverage* is rewritten against `/documents` (D3/D4), then the old specs are deleted | D13 |
| `routes/page-store.ts` | DELETE (successor: `documents/index-store.ts`) | D13 |
| `routes/page-content.ts` (420-line Markdown⇄Tiptap converter) | DELETE — no successor; Markdown is the wire format | D13 |
| `routes/docs.ts`, `routes/docs.test.ts` (standalone `/api/claxedo/docs`) | DELETE with the revision system | D10 |
| `src/doc-store.ts`, `src/document-store.ts` | DELETE with the revision system | D10 |
| `src/document-host/` (`convex-api.ts`, `convex-store.ts`, `convex-store.test.ts` — hosted Convex adapter for the revision store) | DELETE with the revision system; coordinate with the WorkGraph goal owner (its adapter seam consumes this) | D10 |
| `storage/page.sql.ts` | DELETE (successor: `storage/document-index.sql.ts`) | D2/D13 |
| `storage/doc.sql.ts` | DELETE | D10 |
| `routes/pages-arena.ts` + `routes/page-arena-{events,format,opencode,runtime,settings,state,store,wave-runner}.ts` + `storage/page-arena.sql.ts` | ADAPT or DELETE per the Q7 audit — disposition rule: **no file named `*page-arena*` remains**; Arena is either re-pointed at document index ids (renamed `document-arena*`, content via `read(handle)`) or removed pending its own design | D13 |
| `storage/repair.ts` + `repair.test.ts` — **trap:** currently recreates `claxedo_page`, `claxedo_document`, `claxedo_document_revision`, page-status, and arena tables via `CREATE TABLE IF NOT EXISTS`; left alone it silently resurrects every dropped table | REPLACE — rewrite for the target schema only (or delete if the migration runner makes self-repair redundant) | D2 |
| Migrations `20260310000000_initial`, `20260310000001_file_path`, `20260612000000_pages_org_project`, `20260714000100_page_docs_v2_binding` | KEEP as append-only history; add one destructive `_documents_reset` migration dropping `claxedo_page`, `claxedo_document`, `claxedo_document_revision`, and arena tables. History files are inert once `repair.ts` stops recreating them | D2 |
| `server.ts` / `hosted-app.ts` pages+docs route mounting | ADAPT (mount `/documents`, drop `/pages` and `/api/claxedo/docs`) | D3/D13 |
| `route-ownership.ts` (`/pages`, `/api/claxedo/docs` entries), `architecture-ownership.ts` (pages rows) | ADAPT — guard tests fail if forgotten | D3/D13 |
| `hosted-app.test.ts`, `proxy.test.ts`, `architecture.test.ts` pages references | ADAPT | D13 |

### claxedo-app — `features/documents/`

| Artifact | Disposition | Unit |
| --- | --- | --- |
| `data/pages-api.ts` (+test) | REPLACE → `data/documents-api.ts` | D7 |
| `data/docs-api.ts` (+test) (revision locator client) | REPLACE → snapshot-locator schema in `actions/` per D10, then DELETE | D10 |
| `data/arena-api.ts` (+test), `editor/arena-sse.ts` (+test), `editor/page-arena-dock.tsx` | Follow the Arena disposition rule (Q7) | D13 |
| `editor/page-editor.tsx` (1001 lines) + `page-editor-{model,utils,chrome,dock,overlay,toolbar,toc,geometry,tiptap}.*` + `page-editor.css` + `page-editor-state-flow.test.ts` + `page-editor.integration.vitest.tsx` | REPLACE → the D7 composition (`document-editor.tsx` + owned children); old files deleted, old tests deleted (not skipped) | D7/D13 |
| `editor/page-editor-ai.ts` (+test) | SPLIT: selection quick actions extracted and retained (KTD8c); the whole-document path and 14k-char context injection DELETED | D13 |
| `editor/page-index.tsx` (+`page-index.test.ts`, `page-index.vitest.tsx`) | REPLACE → metadata-only index per D7 | D7 |
| `editor/tab-page.tsx` | REPLACE → open flow of the D7 composition | D7 |
| `editor/mermaid-block.ts`, `editor/mermaid-keyboard.ts` (+tests) | ADAPT into `rich-mode` (must serialize per EC-F4) | D7 |
| `editor/slash-commands.tsx` (+test) | ADAPT (in-editor block commands are unrelated to `/docs`; keep) | D7 |
| `editor/status-editor-dialog.tsx`, `editor/status-editor.test.ts` | ADAPT to index metadata (KTD13 statuses) | D13 |
| `actions/page-actions.ts` (+test) | ADAPT to index entries | D13 |
| `actions/doc-actions.ts`, `actions/doc-work-action.ts` (+tests) | ADAPT to the snapshot locator | D10 |
| `ui/content/page-content.tsx`, `ui/content/pages-index-content.tsx` | ADAPT (surface wrappers; ids stay per KTD13) | D7 |
| `app-ports.ts` | ADAPT (+ `/docs` picker port) | D8 |
| `AGENTS.md` | REWRITE for the new layout (agents-md guard requires it) | D13 |

### claxedo-app — outside the feature (adapt in place)

All verified references outside `features/documents/`: workbench state
(`orchestration.ts` `openPage`/`openPagesIndex`, `route-intent.ts`,
`surface-route.ts`, `types.ts` + their tests), `app/integrations/
first-party-content-surfaces.tsx` (+test), `compact-switcher/
switcher-items.ts` (`canUsePages` gate) (+tests), `rail/{global-navigation,
rail-sidebar, rail-sidebar-shell, workbench-shell-header}.tsx`,
`review/review-workspace.tsx`, `features/session/ui/message-timeline.tsx`
(page-session shortcut), `app/demo/handlers.ts` (demo pages fixtures),
`architecture/test-support/mock-api.ts` (+test) (mocked pages endpoints),
`platform/api/api.ts` (+test), `platform/runtime/
workspace-runtime-route-audit.test.ts`. Each is ADAPT in D7/D13: surface ids
and route shape stay (KTD13); API paths, types, mocks, and user-visible
strings move to Documents. e2e `core-docks.spec.ts` references are adapted in
D14.

**Explicit non-targets:** `packages/protocol` / `packages/sdk` grep hits for
"pages" are pagination vocabulary, not the Pages product — untouched. The
shared `@/ui/rich-text` editor stays (KTD5).

### Final staleness sweep (D13 exit gate)

After the sweep, these greps over `packages/**/src` (tests included,
migrations and this docs history excluded) must return nothing:

```text
claxedo_page            page_context           markdownFromContent
pagesApi                pages-api              markdownToDoc
PageEditor              parsePageContent       document_revision_id
"/pages"                page-arena             pages-arena
canUsePages             from-repo import path  claxedo_document_revision
```

Allowed survivors, by decision (KTD13): the surface ids `page` /
`pages-index`, the `/page/<id>` route shape, and workbench function names
(`openPage`) that encode surface identity rather than the product name. The
sweep list lives in a repo script (`scripts/` or a guard test beside the
architecture guards) so it keeps running after this plan closes, not just
once.

## Implementation Units

Unit numbering is D1–D14. Requirements refer to the brainstorm (R1–R29) as
amended by the owner decision. Every unit inherits: TDD (behavior-asserting
tests written with or before the change), typed errors over sentinel values,
illegal states unrepresentable in the contracts, and the Verification
Contract gates.

### D1. DocumentWorkspace port, local managed backend, versions, snapshots

- **Goal:** The editor-facing read/write boundary with opaque version tokens,
  atomic writes, and the automatic bounded snapshot store.
- **Requirements:** R1–R2, R7; KTD1–KTD3, KTD11.
- **Dependencies:** Q3 (lockfile decision), Q4 (project-id stability) may land
  during the unit; port conformance suite is written here.
- **Files:** `packages/claxedo-server/src/documents/{port.ts, local-managed.ts,
  version.ts, history.ts, errors.ts}`, conformance suite
  `packages/claxedo-server/src/documents/port-conformance.ts` +
  `local-managed.test.ts`.
- **Approach:** Port shape from High-Level Design. Version token per KTD3;
  write recipe = temp+fsync+rename+dirfsync in-directory. History per KTD2
  with JSON sidecars `{sha256, reason, actor, sessionId?, createdAt, pins[]}`;
  automatic snapshot policy (around service writes + external-change
  boundaries, debounced + bounded + GC with pins). Path pinning with
  realpath-inside checks.
- **Test scenarios:** EC-A1..A12 file semantics; token stability across
  restart (EC-B5); two concurrent CAS writes (one wins, one typed conflict);
  crash-simulation between temp-write and rename leaves the old file intact;
  snapshot immutability, bounds, and pin-aware GC.
- **Verification:** Conformance suite green against the local backend;
  targeted vitest run per the claxedo-server runner note (full suite hangs —
  run explicit file lists).

### D2. Index schema reset and store

- **Goal:** The document index record as a validated origin union, replacing
  `claxedo_page` — no content column anywhere.
- **Requirements:** R1, R3–R6, R26; KTD12–KTD13.
- **Dependencies:** D1 (types), Q4.
- **Files:** `packages/claxedo-server/src/storage/document-index.sql.ts`,
  destructive Drizzle migration (drop `claxedo_page`, create target tables;
  `claxedo_page_status` kept per KTD13), `documents/index-store.ts`
  (+ tests). `doc.sql.ts` untouched until D10. **Also owns the
  `storage/repair.ts` rewrite** (Cleanup Inventory trap: it recreates every
  legacy table via `CREATE TABLE IF NOT EXISTS` and would silently resurrect
  dropped Pages tables).
- **Approach:** Fields per KTD12; zod-validated union so a managed entry
  cannot carry repository locator fields and vice versa. Metadata-only list
  projections at the SQL level (explicit column select — the current
  unprojected `db.select()` over-fetch is the named regression to kill).
  Archive = `archived_at`, restore clears it.
- **Test scenarios:** union validation rejects mixed records; list never
  returns content-capable fields; EC-E1..E3, EC-E7; status transitions still
  validate; unsigned-local org scoping (`__local__`) preserved.
- **Verification:** migration applies on a fresh and an existing dev DB
  (existing = reset, asserted destructive by design); store tests green.

### D3. HTTP routes `/documents/*` with SSE and auth parity

- **Goal:** The complete route surface: index CRUD, content read/write with
  expected-version, snapshot list/restore, events stream.
- **Requirements:** R3–R6, R15 (server half).
- **Dependencies:** D1, D2. Resolves Q3 (verify the standard local startup
  actually mounts this server — plan-doc broken behavior #1 is closed here).
- **Files:** `packages/claxedo-server/src/routes/documents.ts` (+ tests),
  server mounting in `server.ts`/`hosted-app.ts`; deletion of the pages route
  mounting deferred to D13.
- **Approach:** Reuse the existing `routeScope` signed/unsigned patterns and
  404-on-unauthorized discipline from pages. Content endpoints:
  `GET /documents/:id/content` → `{markdown, version}`;
  `PUT /documents/:id/content` with `If-Match: <opaque token>` → 428 missing /
  409 conflict with current version. Runtime zod schemas + size limits on
  every body. SSE `document.changed` with reasons; reconnect contract per
  EC-B6.
- **Test scenarios:** auth matrix (signed read/write/admin, unsigned loopback,
  non-loopback rejection); 428/409 paths; oversized body; snapshot
  list/restore including restore-CAS conflict; SSE emits on every mutation
  reason.
- **Verification:** route tests green; manual `curl` transcript of the CAS
  conflict flow attached to the PR; standard local startup boots the server
  (Q3 closed with evidence).

### D4. Repository origin backend and recovery states

- **Goal:** Repository documents resolve through workspace checkouts, edit in
  place, expose snapshot/commit, and fail into explicit recovery states.
- **Requirements:** R3, R6, R27 groundwork.
- **Dependencies:** D1 (port), D3 (routes); existing
  `workspace-runtime` git-source + `/file/*` routes.
- **Files:** `packages/claxedo-server/src/documents/repository.ts` (+ tests),
  `routes/documents.ts` additions (`POST /documents/from-repo` — index only,
  **no content import**), git snapshot/commit passthrough endpoints.
- **Approach:** `resolve()` maps `{workspace_id, repository_relative_path}`
  through the authorized workspace root with the same path pinning; version
  token still KTD3 (content hash — blob sha recorded as evidence, not the
  token, so uncommitted edits version correctly). Keep the proven
  `expected:{baseCommit, baseBlobSha}` contract for commits.
- **Test scenarios:** EC-C1..C9 in full; conformance suite from D1 runs
  against this backend.
- **Verification:** conformance + repository tests green from
  claxedo-server and workspace-runtime packages (targeted lists).

### D5. Markdown contract: fixtures, detector, normalization spec

- **Goal:** The documented supported subset, the round-trip detector, the
  normalization spec, and the adversarial fixture corpus — the gate that
  makes rich mode safe (KTD6).
- **Requirements:** R12–R14; brainstorm Dependencies clause 1 (no known false
  negatives before repo files are rich-eligible).
- **Dependencies:** Q1, Q5, Q11 (resolved inside this unit). Independent of
  D1–D4 — runs in parallel.
- **Files:** `packages/claxedo-app/src/features/documents/markdown/{contract.md,
  detector.ts, frontmatter.ts, fixtures/**, detector.test.ts,
  roundtrip.test.ts}`; `packages/claxedo-app/package.json`
  (+`@tiptap/markdown@3.23.4`).
- **Approach:** Fixture-first. Corpus = curated constructs (every GFM feature,
  every Claxedo extension incl. Mermaid) + adversarial set (EC-F1 list) +
  **every real file under `docs/**` of this repo** as a byte-stability
  regression set. Detector = parse→serialize→byte-compare (after opaque
  frontmatter split, Q5). Document the exact normalization set (EC-F6) in
  `contract.md`. Measure and record the EC-F7 churn bar on real files.
- **Test scenarios:** EC-A1/A2/A5/A6 at the contract level; EC-F1, F4–F7;
  fidelity report: % of `docs/**` that opens rich (tracked number — but zero
  false negatives is pass/fail).
- **Verification:** fixture suites green; `contract.md` reviewed; a one-page
  fidelity report checked into the unit's PR description.

### D6. Persistence controller (headless)

- **Goal:** One serialized save controller owning title+body, states, retry,
  conflict, flush-on-blur/close/action, local recovery drafts — fully tested
  without a DOM.
- **Requirements:** R15–R17.
- **Dependencies:** D3 (API shape); parallel with D4/D5.
- **Files:** `packages/claxedo-app/src/features/documents/state/
  {persistence-controller.ts, persistence-controller.test.ts, recovery-draft.ts}`.
- **Approach:** State machine per High-Level Design; single queue, single
  expected-version; capped-backoff retry for `failed`; `conflicted` freezes
  autosave; browser-local draft mirror (EC-B7) keyed by document id+version;
  flush triggers include editor blur (the agent-handoff hygiene mechanism).
  Behavior-asserting state-machine tests — every transition and every EC-B
  case is a named test.
- **Test scenarios:** EC-B1, B2, B4–B7; flush during in-flight save; retry
  gives up visibly, never silently; draft mirror restored after simulated
  crash; blur triggers flush.
- **Verification:** unit tests green under `bun run test`
  (`--conditions=browser` per frontend conventions); zero `.catch(() => {})`
  in the new tree (lint rule or grep gate).

### D7. Editor rewrite: rich mode, source mode, save/conflict UI, index UI

- **Goal:** Decompose the 1001-line editor into a thin composition consuming
  the controller; markdown-native rich editor; labeled source mode; truthful
  save states; metadata-only index.
- **Requirements:** R5, R6 (UI half), R12–R18.
- **Dependencies:** D5, D6, D3.
- **Files:** rewrite under `packages/claxedo-app/src/features/documents/editor/`
  (`document-editor.tsx` composition ≤300 lines; `rich-mode.tsx`,
  `source-mode.tsx`, `save-status.tsx`, `conflict-recovery.tsx`,
  `recovery-states.tsx`), `page-index.tsx` → metadata-only + SSE reconnect,
  `pages-api.ts` → `documents-api.ts`. Surface ids/routes unchanged (KTD13).
- **Approach:** Rich mode = Tiptap + `@tiptap/markdown`, content in/out as
  markdown strings only; `useEditorJSON`/`parsePageContent` path deleted.
  Source mode = plain-text editor (same controller; EC-F3). Open flow =
  two-step contract (summary, then content+version) with detector gate
  (KTD6) and explicit rich↔source transitions (EC-F2). Keyboard/focus/AT
  announcements per R18 built into each new component, not retrofitted.
- **Test scenarios:** open-without-edit produces zero writes (asserted at the
  API layer); EC-E1; source-mode labeling with reason; index renders from
  summaries only (network assertion: no content fetch); a11y smoke (focus
  order, announcements) per R18.
- **Verification:** component tests green; `tsgo -b` clean (run directly per
  typecheck note); **browser evidence**: screen recording of create → edit →
  save states → conflict → recovery, reviewed with vision per the
  Verification Contract.

### D8. Agent access: `/docs` mention, MCP tools, local document grants

- **Goal:** Documents become reachable, discoverable files for any agent
  session — the entire agent story, with no agent-specific write path.
- **Requirements:** R19 (as amended), R10 (discovery without cloning), R26.
- **Dependencies:** D2, D3; Q2 spike and Q13 inventory are the first tasks.
- **Files:** composer integration for `/docs` (location per Q13),
  `packages/claxedo-mcp` new tools `documents_list` / `documents_open`
  (+ tests), session grant plumbing for the managed documents dir (per Q2:
  workspace-runtime/session-env additional-roots or documented fallback),
  mention rendering.
- **Approach:** `/docs` = picker over the index list API; selection resolves
  placement: local ⇒ canonical path + grant check; hosted/remote ⇒ hydration
  trigger (D11/D12 provide the mechanics; until then the mention fails
  closed per EC-D5). MCP tools return honest metadata and real paths only
  (EC-D6); they never fabricate. Grants are per-project-documents-dir and
  enforce containment (EC-D11).
- **Test scenarios:** EC-D1, D4, D5, D6, D11; mention carries
  `{display_name, path, document_id}`; agent file-tool round-trip on a local
  managed doc (integration test with a real session editing the canonical
  file); `documents_list` returns no content bodies.
- **Verification:** MCP + grant tests green; a live local session edits a
  managed document via its own tools and the file changes on disk —
  transcript attached.

### D9. Editor reactivity: watcher, live refresh, conflicts, history UI

- **Goal:** The editor stays truthful under external edits — agents, git,
  other editors — and exposes "what changed" and "restore version".
- **Requirements:** R16 (generalized), amended R23–R25 equivalents; KTD9,
  KTD11.
- **Dependencies:** D1 (watch/snapshots), D3 (SSE), D7; Q6, Q9 first tasks.
- **Files:** `packages/claxedo-server/src/documents/watch.ts` (+ tests),
  editor `external-change.ts(x)`, `changed-on-disk-diff.tsx`,
  `version-history.tsx`, controller integration.
- **Approach:** Watch open documents only (registration follows editor
  open/close over the API); hash-compare before emitting (EC-D4); debounce
  rapid writers (EC-B10). Editor: clean ⇒ reread + detector re-run + refresh
  in place (rich→source transition per EC-D2); dirty ⇒ standard conflict
  recovery. Changed-on-disk diff = last-loaded vs current (Q6 component).
  Version history lists snapshots; restore = CAS write (conflict honest).
  Boundary snapshots for managed docs recorded server-side at detected
  external changes (D1 policy).
- **Test scenarios:** EC-B2 (clean-tab refresh), EC-B3, EC-B8 (dead watcher —
  correctness via CAS), EC-B10, EC-D1..D4; restore conflicts when the file
  moved on; source-mode landing shows the reason and the previous version
  remains restorable.
- **Verification:** watcher + editor tests green; **browser evidence with
  vision review**: recording of an agent session editing an open document —
  live refresh visible, then a deliberate dirty-editor conflict and its
  recovery, then a version restore. The recording must show the pixels, per
  the no-false-positive-verification doctrine.

### D10. WorkGraph work-source continuity + revision-table retirement

- **Goal:** Exactness moves into the WorkGraph ingest call (server-side
  content-hash snapshot); the derived DB revision system is deleted.
- **Requirements:** R1 (identity continuity); EC-E5.
- **Dependencies:** D1 (snapshots), D8 (MCP surface); coordinate with the
  active WorkGraph goal
  (`docs/plans/2026-07-13-001-goal-execute-workgraph-end-to-end.md`) — its
  document-revision adapter seam is the consumer.
- **Files:** WorkGraph ingest tool/route (snapshot-at-ingest),
  `packages/claxedo-app/src/features/documents/actions/
  {doc-work-action.ts, doc-actions.ts}` (+ tests), `docs-api.ts` locator
  schema, the workgraph intake consumer of `DocumentRevisionLocator`; then
  delete `doc.sql.ts`, `doc-store.ts`, `document-store.ts`,
  `routes/docs.ts` and their tests; drop tables in a migration. Also owns
  `moveToRepository` (Q12 journaled transition).
- **Approach:** New locator `{projectId, documentId, snapshotId(content-hash
  ulid), placement}`; the ingest call flushes nothing itself — it reads the
  current file, snapshots it, and hands WorkGraph the snapshot (exact by
  construction at ingest time). Pin snapshots referenced by work-sources
  (EC-E5). Only after the consumer is green does the deletion land (same
  unit, ordered commits).
- **Test scenarios:** locator honest-unavailability preserved (no fabricated
  ids); handoff content equals file bytes at ingest (hash assert); GC
  respects pins; workgraph intake round-trip with the new locator; EC-E6
  journal crash cases.
- **Verification:** claxedo-app + workgraph targeted tests green; grep gate:
  zero references to `document_revision_id`/`claxedo_document_revision`
  outside migrations.

### D11. Hosted managed backend + hydration/write-back sync

- **Goal:** The same `DocumentWorkspace` port over durable blob storage;
  compute disposable (R8); per-document hydration with conditional
  write-back (KTD10) so agent VMs work on ordinary files.
- **Requirements:** R8, R10.
- **Dependencies:** D1 conformance suite, D8 (hydration trigger points);
  Q8, Q10, Q14 (resolved first; Q8/Q14 as ADRs).
- **Files:** `packages/claxedo-server/src/documents/hosted-managed.ts`
  (+ tests), hosted-app mounting, hydration manifest + write-back loop in
  the session runtime (owner per Q14), config plumbing.
- **Approach:** Keys `documents/<org>/<project>/<document-id>/<slug>.md`;
  token = ETag behind the opaque type; conditional put = the same `write()`
  semantics; snapshots as immutable keys. Browser editing goes
  server↔blob directly — no VM involved. Hydration: download one object at
  its version to `.claxedo/docs/<document-id>/<slug>.md` in the session
  root; manifest `{documentId, path, baseVersion}`. Write-back: debounced
  watcher + end-of-turn sweep, whole-file upload if-match; success advances
  manifest + emits `document.changed`; mismatch parks the entry conflicted
  (EC-D7, EC-D9).
- **Test scenarios:** port conformance green against a storage emulator;
  EC-D7..D10; VM-loss criterion (blob holds last written version); hydration
  transfers only the target document (object-count assertion); two-session
  CAS serialization.
- **Verification:** conformance + hosted tests green; staged environment
  smoke with a real bucket recorded as release evidence (deployment proof is
  not waived by repository proof).

### D12. Cloud agent on local documents (relay-brokered hydration)

- **Goal:** The KTD10 sync loop with the local app as the storage side: a
  cloud VM hydrates a selected local document over the relay under a
  short-lived scoped capability and write-back lands through the local
  app's CAS write. Unreachable local app ⇒ documents don't exist to the VM.
- **Requirements:** R11; brainstorm Dependencies clause 3.
- **Dependencies:** D8, D11 (shared sync mechanics); capability design
  reviewed first (installation credential + per-document job capability —
  reuse relay JWT machinery and `user-hosted/local-worktree` claims). This
  unit is the plan's designated cut line: D1–D11 ship without it.
- **Files:** relay-provider capability minting, local app broker endpoints
  under `documents/`, VM-side hydration source config — exact files fixed by
  the reviewed design doc.
- **Approach:** Same manifest/write-back loop as D11 with transport =
  relay tunnel and authority = local app. Capability bound to
  `{documentId, allowed ops, expiry}`; storage/broker credentials never
  enter the agent process or model context.
- **Test scenarios:** capability cannot read a second document; expired
  capability rejected; unreachable local app fails discovery closed
  (EC-D5); write-back conflicts behave as EC-D7.
- **Verification:** security-reviewed design doc; live smoke: local doc,
  cloud VM session, relay round-trip, CAS apply — with transcript evidence.

### D13. Surface adaptation and deletion sweep

- **Goal:** Every remaining Pages consumer moved to the new contracts; every
  replaced artifact deleted; no dual paths left.
- **Requirements:** Clean Replacement Rules (2026-07-15 plan); R19 (document
  owns no chat — session binding stays optional metadata).
- **Dependencies:** D7, D9, D10; Q7 (Arena write audit, first task).
- **Files:** the **Cleanup Inventory** section is this unit's authoritative
  work list — every row marked D13 (and any row an earlier unit left
  pending), including the Arena disposition (Q7), the outside-the-feature
  adaptation list, `canUsePages`, statuses re-mount (KTD13), and the
  ownership-registry updates.
- **Approach:** Work the inventory table row by row; a row is closed by a
  commit that deletes/replaces/adapts it *and* its tests. Finish by
  installing the **final staleness sweep** as a persistent guard (script or
  guard test beside the architecture guards) so the gate outlives this plan.
  Old tests for removed contracts deleted, not skipped.
- **Test scenarios:** Arena still runs against a document (context injected
  from `read()`); export download equals file bytes exactly; no route
  accepts Tiptap JSON anywhere (negative tests); selection quick action
  still produces a normal autosaved human edit.
- **Verification:** grep gates green; full targeted suites of claxedo-server
  and claxedo-app green; `bun run build` in workgraph + app per typecheck
  conventions.

### D14. End-to-end proof and release evidence

- **Goal:** The brainstorm's Success Criteria (as amended) proven on the real
  app with vision-reviewed evidence — no false positives.
- **Requirements:** All Success Criteria bullets; verification doctrine.
- **Dependencies:** D1–D10 (local scope), D11 (hosted scope), D13; Q15.
- **Files:** `packages/claxedo-app/e2e/playwright/documents-core.spec.ts`
  (or the consolidated-spec home per the e2e 20-spec plan), fixture docs,
  recording tooling.
- **Approach:** One journey spec per Success Criterion, including the
  restart-survival journey (create managed doc → delete checkout → restart
  app → reopen exact content) and the agent journey (`/docs` mention → agent
  edits with its own tools → live refresh in the open editor → dirty-editor
  conflict → version restore). Assertions include geometric truth (bounding
  box + elementFromPoint), not CSS visibility. Screenshots/video captured at
  every claimed success point.
- **Test scenarios:** the Success Criteria bullets, each as a named journey;
  EC-B2 two-tab journey; EC-C1 recovery journey; EC-D2 out-of-contract
  agent-output journey.
- **Verification:** `bun run test:e2e:core` (or equivalent) green **and** a
  vision-capable reviewer has actually watched the captured evidence and
  reported the visual verdict separately from the test verdict. Evidence
  contradicting an assertion means the assertion is the bug.

## Sequencing

```text
Wave 1 (parallel): D1, D2, D5            # port+backend | schema | markdown contract
Wave 2 (parallel): D3, D4, D6            # routes | repo backend | controller
Wave 3 (parallel): D7, D8                # editor | agent access (/docs + MCP + grants)
Wave 4 (parallel): D9, D10               # reactivity+history | workgraph seam
Wave 5 (parallel): D11, D13              # hosted backend+sync | deletion sweep
Wave 6:            D12 (gated on capability design), D14
```

D12 is the designated descope if the capability design stalls; nothing else
depends on it. D14 (local scope) can run after Wave 4 and re-run after Wave 5.

## Risks and Mitigations

- **`@tiptap/markdown` fidelity below expectations (Q1):** source mode is the
  designed safety net; the fidelity report in D5 makes the exposure a number,
  not a surprise.
- **Local session grant (Q2):** the fallback (local hydration + write-back,
  same mechanics as hosted) is fully specified, so the zero-copy ideal can
  degrade gracefully without redesign.
- **Lost-update window in the lock-free model:** an agent and a dirty editor
  can both produce work concurrently; CAS guarantees no silent overwrite and
  the conflict flow preserves both sides — but a user can still *choose*
  poorly. Accepted deliberately (owner decision); snapshots + git bound the
  damage. Named in EC-B3/EC-D7 tests so the behavior is proven, not hoped.
- **Write-back debounce loss window (EC-D8):** VM death loses at most the
  debounce interval of unsynced edits; stated in the product doc, tuned in
  Q14's ADR.
- **WorkGraph coupling (D10):** the active WorkGraph goal is mid-flight;
  land D10 as consumer-first ordered commits and coordinate the locator
  schema change with that plan's owner before deleting anything.
- **Editor rewrite scope creep (D7):** KTD13 freezes routes/surfaces; the
  unit's DoD is behavior parity for the retained UX, not visual redesign.
- **Verification theater:** every UI-bearing unit carries the vision-review
  requirement; green Playwright alone never closes a unit (house doctrine).

## Verification Contract

| Gate | Applies to | Required proof |
|---|---|---|
| Port conformance | D1, D4, D11 | Conformance suite green per backend; crash/atomicity simulations included |
| Server | D1–D4, D9–D13 | From `packages/claxedo-server`: `bun typecheck` + **targeted** vitest file lists (full suite hangs locally — never claim from a hung run) |
| App | D5–D9, D13 | From `packages/claxedo-app`: `tsgo -b` directly, `bun run test` (`--conditions=browser`); `bun run build` in `packages/workgraph` first when its src changed |
| Markdown fidelity | D5 | Zero false negatives on the adversarial corpus; byte-stability on all of `docs/**`; churn bar (EC-F7) measured and reported |
| Agent integration | D8, D9 | A real local session edits a managed document via its own file tools; transcript + on-disk hash change attached; MCP tools return no fabricated paths |
| Cleanup + staleness | D2, D10, D13 | Cleanup Inventory table has zero pending rows; the final staleness sweep (see Cleanup Inventory) returns nothing and is installed as a persistent guard; no `.catch(() => {})` in documents code |
| Placement review | Every unit | Each unit's diff checked against the Placement and layering map + import-graph guards (`architecture.test.ts`, route-ownership registries, agents-md guard); out-of-layer files are findings |
| Browser + vision | D7, D9, D14 | Recordings/screenshots at every claimed success point, actually reviewed with vision; visual verdict reported separately from test verdict; geometric assertions (bounding box + hit-test) in e2e |
| Hosted | D11 | Conformance vs emulator **and** staged real-bucket smoke; repository proof does not waive deployment proof |
| Security | D12 | Reviewed capability design doc before implementation; scoped-capability negative tests |
| Hygiene | All | `git diff --check`; deleted contracts have deleted tests; no dual read/write paths anywhere |

## Definition of Done

- [x] D1 port + local backend: conformance green, EC-A cases named tests, crash-atomicity simulated, snapshot bounds + pin-aware GC proven. Progress: port conformance and atomic/snapshot suites passed in the final server matrix.
- [x] D2 index schema: content-free union schema installed, destructive reset applied, metadata-only list proven at SQL level. Progress: migration/store suites and live metadata-only list passed.
- [x] D3 routes: CAS (428/409) + auth matrix + size limits + snapshot restore + SSE reasons tested; standard local startup boots the server with evidence (Q3 closed). Progress: route matrix passed; unsigned startup returned `/documents` 200, retired `/pages` 404, and CAS behaved correctly.
- [x] D4 repository backend: EC-C1..C9 tested; conformance green; recovery states render (not blank). Progress: repository suite passed and the retained live browser journey renders actionable deletion recovery.
- [x] D5 markdown contract: `@tiptap/markdown@3.23.4` adopted; adversarial corpus zero false negatives; `docs/**` byte-stability; frontmatter opaque round-trip (Q5); churn bar measured (EC-F7); fidelity report filed. Progress: production extension parity is shared and the current 61-file corpus report is recorded in release evidence.
- [x] D6 controller: state machine fully test-named (EC-B1..B7); flush-on-blur proven; no silent catch; local recovery draft survives simulated crash. Progress: controller/recovery matrix passed; final picker race regressions passed 9/9.
- [x] D7 editor: composition ≤300 lines; open-without-edit writes nothing (API-asserted); source mode labeled with reason; index metadata-only (network-asserted); R18 a11y smoke; vision-reviewed recording of save/conflict/recovery. Progress: headed rich canaries and retained mock/live recordings passed visual review.
- [x] D8 agent access: `/docs` mention working (Q13 closed); `documents_list`/`documents_open` honest (EC-D5/D6); local grant contained (EC-D11, Q2 closed); live session edits a managed doc with its own tools — transcript attached. Progress: real session tool smoke and live `/docs` granted-path journey passed with exact hashes.
- [x] D9 reactivity + history: live refresh on agent edit (vision-reviewed recording); dirty-editor conflict preserves both sides (EC-B3); dead-watcher correctness (EC-B8); out-of-contract refresh lands in source mode with restorable previous version (EC-D2); version restore CAS-honest. Progress: complete mock/live reactivity, conflict, source fallback, and restore journeys passed.
- [x] D10 workgraph seam: snapshot-at-ingest locator live in intake; pins enforced; `moveToRepository` journal crash-cases tested; revision tables + docs routes deleted; grep gate green. Progress: WorkGraph/move suites passed and the persistent retirement guard is green.
- [x] D11 hosted backend + sync: conformance green; single-document hydration proven by object-count; write-back CAS conflicts park honestly (EC-D7..D10); VM-loss criterion met; staged real-bucket smoke recorded. Progress: hosted/Miniflare matrix passed and authenticated staging R2 exact-byte/CAS smoke is recorded.
- [x] D12 relay-brokered local hydration: capability design security-reviewed; scoped-capability negative tests; live relay round-trip smoke — or unit explicitly descoped by owner decision. Progress: scoped negative matrix and live relay read/write/stale-CAS smoke passed.
- [x] D13 sweep: Cleanup Inventory has zero pending rows; final staleness sweep returns nothing and is installed as a persistent guard; Arena disposition executed per Q7 (no `*page-arena*` file remains); `repair.ts` cannot resurrect legacy tables; export equals file bytes; no route accepts Tiptap JSON; selection quick actions still work editor-local. Progress: retired files were renamed/deleted, CSS joined the guard, and the final guard passed 2/2.
- [x] D14 proof: every Success Criterion a named journey including the agent live-edit journey; geometric assertions; evidence watched with vision and visual verdict reported separately. Progress: full mock 11/11 and live 5/5 evidence is retained under `docs/plans/evidence/documents/`.
- [x] Placement: every new module sits at its mapped home; ownership registries updated; architecture/agents-md guards green; an independent reviewer confirmed no out-of-layer files. Progress: package architecture gate passed 165/165; final independent placement review recorded no blocker.
- [x] Unknowns register: Q1–Q15 each closed with a recorded answer or an explicit owner-approved default. Progress: decisions are recorded in `docs/decisions/2026-07-17-documents-core-implementation-answers.md`.
- [x] Docs: `docs/plans/README.md` updated; `contract.md` (markdown subset) and the Q8/Q14 ADRs checked in; the brainstorm annotated with the R19–R25 supersession. Progress: index, contract, ADRs, implementation answers, release transcript, and visual verdict are present.

## Execution: parallelize with agents and workflows

This plan is written for agent-parallel execution. Mandates:

- **Disjoint file ownership per agent.** Wave 1 runs three agents with zero
  file overlap (D1 `claxedo-server/src/documents/**`, D2 `storage/**`, D5
  `claxedo-app/src/features/documents/markdown/**`). Later waves keep the
  same rule; the only shared file classes (route mounting, package.json) are
  owned by the wave integrator.
- **Pipeline, don't barrier.** Within a wave, an agent that finishes moves to
  review/verification of its own unit immediately; the next wave starts per
  dependency edge, not per wave completion (D6 needs only D3's API shape,
  which is fixed in this plan — it can start against the contract).
- **Parallel research/verification.** Q1/Q5 fixture building, the Q2 grant
  spike, the Q13 composer inventory, and the Q7 Arena audit are independent
  read-only tasks — run them as parallel explore agents before their owning
  units start.
- **Adversarial verification per unit.** Before a unit's DoD box is checked,
  spawn an independent reviewer agent with the unit's Test scenarios + Edge
  Case rows as a checklist to refute the implementation; findings verified
  against code, not trusted from summaries.
- **Vision review is a distinct agent step.** For D7/D9/D14, a vision-capable
  reviewer reads the actual PNGs/video frames and reports what is visible in
  the pixels, separately from the test result. A unit claiming completion
  from green assertions alone is rejected by doctrine.
- **Workflows.** Multi-unit waves and the D5 fixture fan-out (per-construct
  fixture agents; per-file `docs/**` byte-stability sweep) are natural
  Workflow fan-outs; use one workflow per wave with per-unit phases and a
  final completeness-critic agent asking "which EC rows have no named test?"
