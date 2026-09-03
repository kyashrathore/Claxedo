---
title: "Claxedo Documents — Product Features and Architecture"
type: feat
date: 2026-07-16
status: active
audience: product + engineering (readable companion)
companion_of: "2026-07-16-001-feat-documents-core-implementation-plan (retired; recover from git history)"
---

# Claxedo Documents — Product Features and Architecture

This is the readable companion to the implementation plan
`2026-07-16-001-feat-documents-core-implementation-plan` (retired from the tracked
tree; recover it from git history). It answers two questions: **what does the user
get**, and **how does each feature actually work under the hood**. The
implementation plan owns units, edge cases, and gates; this doc owns the mental
model.

## The idea in one paragraph

Every document is **one Markdown file** with **one home**. Either Claxedo owns
the file (a *managed* document, stored in Claxedo's durable storage, safe from
deleted checkouts and dead VMs) or a Git repository owns it (a *repository*
document, edited in place at its repo path). The database keeps only an
**index** — names, locations, workflow state — never a copy of the content.
Humans edit the file through a rich Notion-like editor that speaks Markdown.
Agents work on the same file **the way agents already work on any file**: the
document is reachable in their session's filesystem and they read and edit it
with their ordinary tools. There is no special agent pipeline, no lock, no
approval bracket — the editor simply stays truthful when the file changes
underneath it.

Why this shape: the current Pages system stores editor JSON in the database,
imports repository Markdown into that column, and exports it back — which
created multiple copies that drift, lossy conversions, and documents that die
with their session or VM. One file, one owner, agents-as-normal-collaborators
fixes the whole class.

---

## Part 1 — What the user gets

### 1. The Documents index

One list per project showing **managed** and **repository** documents
together. Every row shows where the document lives (a Claxedo-managed file, or
`docs/foo.md @ main` in a repo), when it changed, and its state — including
"conflict", "file missing", or "archived". Two primary actions: **New
document** and **Add to Documents**.

The list is instant even with hundreds of documents because it is
metadata-only — no document body is ever downloaded to render it. It updates
live when anything changes (another tab, an agent, a Git commit).

### 2. Create a document without Git, keep it forever

**New document** asks for a name, creates a Markdown file under Claxedo's own
storage, and opens the editor. No repository, no sign-in, no agent session
required. The user can delete the project checkout, restart Claxedo, replace
their cloud workspace — the document is still in the index and reopens with
the exact same content. In hosted mode the same is true when the VM that last
edited it is destroyed: compute is a disposable client, never the owner.

### 3. Bring an existing repo file in, without copying it

**Add to Documents** on any Markdown file in a repository indexes it — the
file stays exactly where it is, and editing it edits the real file. The
editor shows the branch and working-tree state and offers the normal Git
loop: see the diff, commit. There is no import step and no export step,
because there is no second copy.

### 4. A rich editor that never lies about Markdown

Documents open in a Notion-like rich editor (Tiptap) — headings, lists,
tables, task lists, code and Mermaid blocks — but what's on disk is always
plain Markdown. Two honesty guarantees:

- **Opening a file never rewrites it.** View a document all day; the bytes
  don't change until the first actual edit.
- **Unsupported Markdown is never destroyed.** If a file uses constructs the
  rich editor can't round-trip faithfully (unusual syntax, merge-conflict
  markers, exotic HTML), it opens in a clearly labeled **source mode** — a
  plain-text editor with the same autosave and conflict handling. The UI says
  why. Going back to rich mode is an explicit action that re-checks the file.

Files with YAML frontmatter keep it byte-for-byte; the rich editor treats it
as an opaque header it must not touch.

### 5. Autosave that tells the truth

Edits save continuously, and the save indicator has exactly five honest
states: *dirty*, *saving*, *saved*, *failed*, *conflicted*. A failed save
keeps the draft and shows a retry. If something else changed the file —
another tab, an external editor, **an agent**, a branch switch — the editor
reacts instead of clobbering: a clean editor refreshes to the new content in
place; an editor with unsaved changes stops and offers recovery (compare,
reload from disk, save the draft as a copy, or knowingly overwrite). Closing
a tab flushes first; a draft additionally survives a crash via browser-local
recovery storage. Nothing is ever silently dropped — the current Pages editor
loses edits on unmount and swallows save errors; the replacement makes both
structurally impossible.

### 6. Work with an agent on any document — no special mode

There is no "Ask agent" machinery. In any agent session, the user types
**`/docs`** in the composer: a picker lists the project's documents (from the
index), they select one, and the message carries a reference to that
document. From there it's a normal conversation — "tighten the intro",
"restructure this around the new API" — and the agent reads and edits the
file itself with its ordinary tools, exactly the way it edits code.

What the user sees while that happens:

- The open editor **live-refreshes** as the agent saves — they can watch the
  document change.
- If they were mid-edit themselves, the editor doesn't clobber or get
  clobbered: the standard conflict recovery appears with both versions.
- "What did the agent change?" is answered the way it is for code: the
  editor's **changed-on-disk diff** (against what was last loaded) for a
  quick look, Git diff for repository documents, and **version history** for
  managed documents.

Getting an earlier version back:

- **Repository documents:** Git is the safety net, as it is for code —
  working-tree diff, discard, checkout.
- **Managed documents:** Claxedo keeps automatic bounded **version
  snapshots** (taken around saves and whenever an external change lands), so
  the editor offers "Restore version" even after closing and restarting.

The agent can also discover documents itself: Claxedo's MCP tools let it list
the project's documents and open one by name, so "find my pricing notes and
update the tiers" works without the user pre-selecting anything.

Selection quick actions (improve / fix / shorten on highlighted text) remain
instant and inline in the editor: the suggestion streams in as a preview the
user accepts or discards, and an accepted suggestion is just a human edit
that autosaves. They never touch the file directly.

### 7. Promote a managed document into a repository

**Move to project** writes the managed file to a chosen repo path, flips its
index entry to repository origin, and from then on the repo file is the sole
authority — commit it like any other file. Identity, history, and deep links
survive the move. A separate **Export snapshot** produces an unlinked copy
and never creates a sync relationship.

### 8. Same model everywhere: local, hosted, and cloud agents

- **Unsigned local:** documents live on the user's machine under Claxedo's
  app data; everything above works with no account. A local agent edits the
  canonical file directly — there are no copies at all.
- **Signed hosted:** managed documents live in durable account-scoped blob
  storage; the browser edits them through the same API; an agent VM
  materializes a document into its filesystem only when a conversation
  actually involves it, and changes sync back conditionally.
- **Cloud agent, local documents:** a local user can run the agent on a
  cloud VM; the selected document is shipped to the VM and synced back
  through the local app, which stays the authority. The VM never discovers
  local files on its own, and losing the VM loses nothing.

---

## Part 2 — How it works technically

### Architecture at a glance

```mermaid
flowchart LR
  subgraph Client [claxedo-app]
    IDX[Documents index UI] --> API
    ED[Editor rich/source] --> PC[Persistence controller]
    PC --> API[documents-api client]
    CMP["Session composer /docs picker"] --> API
  end

  subgraph Server [claxedo-server]
    API --> RT[/routes: /documents/*/]
    RT --> IX[(Index DB\nSQLite, metadata only)]
    RT --> DW[DocumentWorkspace port]
    RT -. SSE document.changed .-> IDX
    RT -. SSE document.changed .-> ED
    DW --> LM[Local managed backend\nCLAXEDO data dir]
    DW --> RB[Repository backend\nworkspace checkout + git]
    DW --> HM[Hosted managed backend\nblob store, ETag CAS]
    DW --> HIST[(Version snapshots\nimmutable .md files)]
    WATCH[Open-document watcher] --> RT
  end

  subgraph Agent [agent session — any harness]
    FS[Ordinary file tools] --> DOC[the document file]
    MCP[claxedo-mcp: documents_list / documents_open] --> RT
  end

  DOC -. same file .- LM
  DOC -. same file .- RB
  HYD[Hydrate + conditional write-back] --- HM
  DOC -. hosted only .- HYD
```

Three rules make the diagram trustworthy:

1. **The database never stores content.** One SQLite table of index records;
   the list API returns summaries by construction (SQL-level column
   projection), so "index accidentally ships bodies" can't regress. Content
   lives only in files (canonical) and immutable snapshots (history).
2. **The human editor writes through `DocumentWorkspace`,** which gives it
   version-checked saves, snapshots, and recovery states. **Agents don't** —
   they use their harness's file tools on the same file. The service treats
   an agent exactly like an external editor: a source of file changes to
   detect, never a special client to bracket.
3. **Every editor save is a compare-and-swap.** The editor can't clobber a
   file it hasn't seen the latest version of — that single rule is what
   makes lock-free human+agent coexistence safe.

### The index record

```text
id, org_id, project_id, display_name
origin_kind:    managed | repository        ← validated union:
  managed_relative_path                       managed fields XOR repo fields
  repository_id, workspace_id,
  repository_relative_path, branch
placement_kind: local | hosted
status, session_id, archived_at
created_at, updated_at, last_opened_at, last_known_file_version
```

The union is enforced in the schema types: a managed entry *cannot* carry a
repository locator, so "which path wins" is unrepresentable. `session_id` is
optional provenance ("the session last used here"), never ownership.
Workflow statuses (draft → in review → done, per-project, validated
transitions) carry over from Pages unchanged as index metadata.

### Storage layout (managed documents)

```text
<CLAXEDO_DATA_DIR ?? ~/.claxedo>/
  documents/<project-id>/<document-id>/<slug>.md      ← the canonical file
  document-history/<document-id>/<ulid>.md            ← immutable snapshots
  document-history/<document-id>/<ulid>.json          ← {sha256, reason, actor, pins…}
```

The physical filename is fixed at creation; renaming a document changes only
`display_name` in the index. That one decision eliminates rename races,
case-insensitive filesystem collisions, and macOS Unicode-normalization bugs.
History lives *outside* the documents directory so an agent editing the
document can never edit history. Snapshots are automatic and bounded — taken
around service writes and when an external change is detected — and they are
what power "Restore version" and the changed-on-disk diff. They are never a
second editable head.

Repository documents have no copies at all: the canonical file is
`<workspace-checkout>/<repository-relative-path>`, resolved through the
authorized workspace root with realpath/symlink containment. Git is their
history.

### Version tokens: how the editor avoids clobbering anyone

Every editor read returns `{markdown, version}` where `version` is an opaque
token — internally `{sha256, size, mtimeMs}` of the content. Every editor
save must present the token it read:

```text
write(handle, {markdown, expectedVersion}):
  current = hash(file)
  if current ≠ expectedVersion.sha256 → VersionConflict {currentVersion}
  write temp file in same directory → fsync → rename over → fsync dir
```

Hash-based tokens mean conflicts are decided by *content truth*, not by a
counter or a clock: they survive server restarts, external editors, branch
switches, and — most importantly — **agent edits happening in parallel**. If
an agent saved the file since the editor last read it, the editor's next save
conflicts instead of overwriting, and the recovery flow shows both versions.
The temp-fsync-rename recipe means a crash at any instant leaves either the
old file or the new file — never a torn one. Hosted mode maps the same opaque
token onto blob ETags; clients can't tell the difference.

### The persistence controller: how autosave stays honest

One client-side state machine owns *all* persistence for an open document —
title and body together, one queue, one expected-version:

```text
idle → dirty → saving → saved
                  ↘ failed     (draft kept, visible retry w/ backoff)
                  ↘ conflicted (autosave frozen; compare / reload /
                                save-as-copy / confirmed overwrite)
flush(): promote dirty→saving now, resolve when settled
```

The controller flushes on tab close, on any content-consuming action, and on
**editor blur** — so when the user switches to the chat composer to talk to
an agent, their latest keystrokes are already on disk by the time the agent
reads the file. No coupling between editor and agent is needed to get that;
it falls out of flushing eagerly.

### How the editor reacts to agent (and any external) edits

Open documents are watched. The flow when the file changes on disk:

```text
file changed (agent save, git checkout, external editor)
  → server detects (watcher on open documents; SSE document.changed)
  → editor compares its state:
      clean   → reread, re-run the rich/source detector, refresh in place
                (user watches the agent's edits appear)
      dirty   → conflicted state: draft frozen, compare view offered
  → "changed on disk" diff available: last-loaded content vs current file
```

Watching is scoped to *open* documents only; if a platform can't watch, the
degraded mode is refresh-on-focus plus the save-time CAS — correctness never
depends on the watcher, only liveness does. If an agent writes content
outside the rich-editing contract, the refresh lands in labeled source mode
with the reason, and the automatic snapshot taken at the change boundary
keeps the previous version restorable.

This one mechanism replaces what would otherwise be a bespoke agent
pipeline: there is no lock, no read-only mode, no operation bracket — the
same reactivity that handles `git checkout` handles the agent.

### How an agent reaches a document

**The principle: make the document an ordinary file in the session's reach,
then get out of the way.**

- **Repository documents** are already in the workspace. Nothing to do.
- **Local managed documents** are real files under
  `~/.claxedo/documents/<project>/…`. The session is granted that project's
  documents directory as an additional accessible root, and the document's
  absolute path is what `/docs` injects into the conversation. The agent
  edits the canonical file directly — zero copies.
- **Hosted / cloud** — see hydration below.

**Discovery has two doors:**

- **`/docs` in the composer** (human-driven): queries the index API
  (metadata only), user picks, and the message gains a document mention —
  display name + resolved path + document id. For hosted/cloud sessions,
  selection triggers hydration first so the path is real before the agent
  looks.
- **MCP tools** (agent-driven): `documents_list` returns index metadata;
  `documents_open(id|name)` resolves — and on hosted, hydrates — the
  document and returns its path. The agent can then read/edit it with normal
  file tools.

### Hosted mode: how hydration and write-back actually work

This is the concrete mechanism behind "VMs hydrate a document only when an
operation needs it":

1. **At rest**, a hosted managed document is one blob object at
   `documents/<org>/<project>/<document-id>/<slug>.md` whose ETag/version is
   the document's version token. The **browser** editor never involves a VM:
   its reads and CAS saves go straight from claxedo-server to the blob store
   (GET → `{markdown, etag}`, conditional PUT with if-match).
2. **When a session needs the document** (user picked it via `/docs`, or the
   agent called `documents_open`), the runtime downloads that one object at
   its current ETag to a stable path inside the VM's filesystem
   (`.claxedo/docs/<document-id>/<slug>.md` in the session's working root)
   and records `{documentId, path, baseEtag}` in a per-session **hydration
   manifest**. Nothing else is transferred — discovery is served by the
   index API, so there is never a reason to list or clone the document root
   into a VM.
3. **Write-back** is a sync loop owned by the session runtime, not the
   agent: a debounced file watcher on hydrated paths (with an end-of-turn
   sweep as the fallback) uploads a changed file with
   `if-match: baseEtag`. Success advances the manifest ETag and emits
   `document.changed` (which is what makes the user's browser editor
   live-refresh). An ETag mismatch — someone edited in the browser meanwhile
   — keeps the VM copy intact, marks the manifest entry conflicted, and
   surfaces the standard conflict state in the editor and index rather than
   overwriting either side.
4. **VM death** at any point loses only unsynced edits in that VM; the blob
   store still holds the last successfully written version, and the index
   entry never pointed at the VM.

The **cloud-agent-on-local-documents** case is the same loop with the local
app as the storage side: hydrate ships the file to the VM over the existing
relay tunnel under a short-lived capability scoped to that document, and
write-back lands through the local app's same CAS write. The local machine
remains the authority; an unreachable local app means the documents simply
don't exist to the VM.

### Repository documents: Git integration

Snapshot and commit reuse the existing workspace-runtime git machinery:
sourcing records `{base_commit, base_blob_sha}`, commits send
`expected:{baseCommit, baseBlobSha}` and 409 on a moved base — the same
compare-and-swap philosophy at the Git layer. Day-to-day *editing* versions
by content hash (so uncommitted edits conflict correctly); Git identifiers
are evidence recorded alongside, used by the commit flow. Missing, moved, or
deleted files and dead workspaces open explicit recovery states (re-locate /
restore-from-snapshot / archive) — never a blank editor.

### The Markdown contract: how rich mode stays lossless

The editor is Tiptap with `@tiptap/markdown` (same pinned version as the rest
of the app); Markdown strings are the only thing that crosses the API —
Tiptap JSON never leaves the browser. Rich-mode eligibility is decided at
open time (and re-checked on every external refresh) by a **round-trip
proof**:

```text
(frontmatter, body) = split(bytes)           # frontmatter kept opaque
rich-eligible ⇔ serialize(parse(body)) == body   (byte-identical after
                                                  documented normalization)
```

If the proof fails, the document opens in source mode with the reason. The
supported subset and the exact normalization rules are documented and pinned
by a fixture corpus (every GFM construct, the Mermaid block, adversarial
cases, and every real file in this repo's `docs/**` as a byte-stability
regression set). A companion quality bar says: a one-paragraph edit in a
repository doc must produce a one-paragraph diff — no whole-file reformats in
someone's PR.

### Move to repository: the one ownership transition

`moveToRepository` is journaled and ordered so a crash can't lose content:
write the repo file → verify bytes → flip the index entry to repository
origin → archive the managed file. Between any two steps there are *two*
copies, never zero; reopening reconciles from the journal. After the flip the
repo file is the sole authority — no sync relationship remains.

### Events and liveness

Mutations and detected external changes emit `document.changed` over SSE
with a reason. Events are *invalidation hints*, not a ledger: the client
refetches on receipt and once on every reconnect, so a dropped stream
degrades to a refresh, never to silent staleness.

### What is deliberately deleted

The replacement removes: the `claxedo_page.content` Tiptap-JSON column, the
420-line server Markdown⇄Tiptap converter, the from-repo *content import* and
DB *export* endpoints (export becomes "download the file"), the derived
document/revision tables, and every dual read/write path. It also
deliberately does **not** build: an agent operation pipeline, document locks
or read-only modes, an accept/reject workflow for agent output, or any
agent-specific write path — the harness's own tools plus editor reactivity
cover all of it.

---

## Feature → mechanism map

| User-facing feature | Load-bearing mechanism |
| --- | --- |
| Index is instant, always current | Metadata-only SQL projection + SSE invalidation hints |
| Document survives checkout/VM/restart | Managed file under Claxedo durable root; DB stores location, not content |
| Edit a repo file "in place" | Repository backend resolves the real path; no copy exists |
| Opening never changes a file | First-mutation serialization gate; detector never writes |
| Unsupported Markdown is safe | Round-trip proof at open and on refresh; labeled source mode; opaque frontmatter |
| Truthful save indicator | Single persistence controller state machine; flush on blur/close/actions |
| Human and agent never clobber each other | Content-hash CAS on editor saves + external-change reactivity; no locks |
| Watch the agent edit live | Open-document watcher → SSE → clean-editor refresh in place |
| "What changed?" | Changed-on-disk diff vs last-loaded; Git diff for repo docs; snapshots for managed |
| Get an earlier version back | Git (repository docs); automatic bounded snapshots + Restore (managed docs) |
| Agent finds and edits docs itself | `documents_list` / `documents_open` MCP tools returning real paths |
| `/docs` mention in any session | Composer picker over index metadata; injects path + id; triggers hydration when remote |
| Hosted doc survives VM loss | Blob object is authoritative; VM copy is a manifest-tracked hydration |
| No wholesale clone to VMs | Discovery via index API; per-document hydrate on demand; conditional ETag write-back |
| Cloud agent, local files stay local | Relay-tunneled per-document hydrate + write-back through the local app's CAS |
| Move to Git without loss | Journaled ordered transition; two copies during, one after |
