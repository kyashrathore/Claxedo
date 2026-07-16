---
title: "Pages Filesystem Documents - Current State and Clean Replacement Plan"
type: fix
date: 2026-07-15
status: active
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Pages Filesystem Documents

## Point of View

Pages is a durable index and human-agent workspace for Markdown files.

A document has one authoritative file. That file is either managed by Claxedo
outside Git or owned by a Git repository. Humans and agents shape the same file,
can leave and return to it, can understand and undo changes, and can commit a
repository-owned document through the normal Git workflow.

Pages is not a database content system. Database rows identify documents,
locate their files, and store workflow metadata. They do not store a second copy
of Markdown.

This is a clean replacement of the current pre-release Pages model. There is no
existing-user data migration, legacy read path, dual write, backfill, or
compatibility period. The development Pages database may be reset and the
schema and APIs installed directly in their target form.

## Product Outcome

The primary loop is:

1. Create a managed Markdown document or index a repository Markdown file.
2. Open it from the Documents index.
3. Edit it directly or ask an agent to change it.
4. Inspect the exact change, continue editing, or undo it.
5. Close the document and find it again later.
6. For repository documents, review and commit the filesystem change to Git.

Document identity survives tabs, sessions, processes, and agent tasks. A session
is temporary execution context and optional provenance; it never owns the
document.

## Core Requirements

### One canonical file

- Every indexed document resolves to one filesystem path.
- The browser editor and agents read and write that file through one document
  workspace boundary.
- The index database contains no Markdown body, rich-text JSON, or other content
  projection.
- Temporary in-memory or sandbox copies are implementation details and cannot
  become independently writable authorities.

### Two document origins

| Origin | Canonical location | History owner | Git actions |
| --- | --- | --- | --- |
| `managed` | Claxedo documents root | Claxedo filesystem revisions | Unavailable until moved into a repository |
| `repository` | A path inside a repository checkout | Git, plus short-lived recovery snapshots for uncommitted operations | Diff, stage, commit, and push |

Both origins use the same editor, agent actions, save state, diff presentation,
undo behavior, deep links, and index.

### Document placement

Origin and placement are independent:

| Placement | Working filesystem | Durable backing |
| --- | --- | --- |
| `local` | The user's Claxedo root or local repository checkout | The user's device |
| `hosted` | A path materialized inside an authorized cloud workspace | Account- or installation-scoped Claxedo storage for managed files, or the hosted Git workspace for repository files |

A managed document may therefore be local or hosted. A repository document may
likewise use a local checkout or a hosted checkout. The index records both its
content owner and the placement needed to resolve its path.

Local and hosted roots are not automatically bidirectionally synchronized. A
hosted document opened by the desktop app uses the hosted document service and
may create a disposable local cache. Moving a document between placements is an
explicit ownership-preserving operation with an expected-version check.

### Agent execution placement

Agent execution is independent of document origin and document placement. A
local document may be edited by a local agent or by an agent running in a cloud
VM without moving the document into hosted storage.

For local document plus cloud execution:

1. The local Claxedo app flushes the canonical local file and records its
   version.
2. It creates an operation checkout for the cloud VM.
3. The VM edits the checkout with ordinary filesystem tools.
4. The result returns to the local app.
5. The local app applies it only when the local file still matches the starting
   version.

The cloud checkout may be retained briefly for operation recovery, but it is
not a hosted document and does not change the index entry's placement.

### Durable reopening

- Managed documents remain available after Claxedo restarts.
- Repository index entries retain repository identity, branch, and relative path.
- Hosted Claxedo can restore the required durable document workspace or Git
  checkout before opening a document.
- Missing files, unavailable workspaces, and moved repository paths produce
  explicit recovery states rather than blank editors.

### Human-agent editing

- Human changes are saved with an expected file-version token.
- Starting an agent action first flushes pending human changes.
- The agent receives the exact document path and normal filesystem tools.
- One document mutation runs at a time in the first milestone; the editor shows
  that the agent is working and does not concurrently write.
- Claxedo records the before and after file versions for an agent operation and
  presents the resulting diff.
- Undo writes the prior file version as a new operation; it never silently
  rewinds external Git history.

### Trustworthy persistence

- Title and Markdown changes use one serialized save controller.
- Save state is visible as dirty, saving, saved, failed, or conflicted.
- Network and filesystem failures retain the user's draft and expose retry.
- Close and content-consuming actions flush pending changes.
- A stale expected version returns the current file version and preserves the
  local draft for comparison.
- File replacement is atomic within the capabilities of the active workspace.

### Markdown fidelity

- The canonical file contains UTF-8 Markdown, never Tiptap JSON.
- The rich editor is a projection over a documented lossless Markdown subset.
- Supported constructs preserve Markdown meaning across open and save.
- Files containing unsupported constructs open in lossless source mode.
- Raw HTML and active URLs are rendered under the application's existing
  sanitization and complexity limits.

## User Journeys

### Start a managed document

The user selects **New document**, chooses a project context and name, and
Claxedo creates a Markdown file below its documents root. The document opens in
the editor, appears in the index immediately, and remains available without a
Git repository or active agent session.

### Index a repository document

The user opens an existing Markdown file from a repository and selects **Add to
Documents**. Claxedo records its repository locator and opens the file in the
same document workspace. Editing changes the repository file directly. The UI
shows the branch and working-tree state and offers normal Git actions.

### Ask an agent to improve a document

The user gives an instruction against the open document. Claxedo flushes human
edits, records the current file version, and starts the agent with the resolved
filesystem path. When the agent finishes, Claxedo reads the new file version and
shows the change. The user can keep editing, undo the operation, or ask for
another change.

### Return later

The user opens the Documents index and sees managed and repository documents in
one list with origin, project, modified time, and state. Opening an item resolves
its current workspace and file. The previous agent session may be reused when
available, but a new session can continue against the same document.

### Move a managed document into Git

The user selects **Move to project**, chooses a repository-relative destination,
and confirms. Claxedo writes the file, updates the index entry to repository
origin, and removes or archives the former managed file after verification. The
repository file becomes the sole authority. The user can then commit it.

A separate **Export snapshot** action may create an unlinked copy. Export never
creates an ongoing synchronization relationship.

## Current Implementation

### Useful implementation to retain

The current product already contains valuable parts of the desired experience:

- a Documents index integrated into the workbench,
- stable Page routes, tabs, and deep links,
- a capable Tiptap editor with Markdown-oriented controls,
- selection and whole-document agent actions with change previews,
- Page-bound session shortcuts,
- status organization,
- Git snapshot and commit runtime operations,
- tests for Page authorization, conflicts, Git guards, editor helpers, agent
  previews, and index actions.

These pieces should be retained where they fit the filesystem authority model.

### Broken behavior to correct

1. The normal local startup does not reliably start the server that owns Pages.
2. Title and content use separate debounce queues and can conflict with each
   other or disappear on unmount.
3. Save failures are swallowed and can leave the editor looking saved.
4. Export, agent handoff, and Git actions can read content before pending edits
   are persisted.
5. Markdown conversion loses or changes links, breaks, nesting, tables, and
   other constructs.
6. The index fetches complete content bodies and refetches all content after
   invalidation.
7. Page event streaming does not recover reliably after termination.
8. Status identity and global-list authorization are not correctly scoped.
9. Runtime validation and content-size limits are incomplete.
10. Permanent deletion is immediate and lacks archive or undo.
11. The editor component owns persistence, agent state, Git state, Arena, table
    of contents, status, and layout in one lifecycle.

### Architecture that must be replaced

The current `claxedo_page.content` column is the primary editor body. Repository
Markdown is imported into that column as Tiptap JSON, edited independently, and
later exported or committed back to the file. A second document/revision system
can also advance content independently.

This produces multiple competing authorities:

- Page content,
- document revision Markdown,
- the repository file,
- editor-local Tiptap state.

The replacement removes persisted Page content and database-stored revision
bodies. The filesystem file becomes authoritative and editor state becomes
disposable.

## Target Architecture

### Document index record

The replacement Page record is a document index entry:

```text
id
org_id
project_id
display_name
origin_kind: managed | repository
placement_kind: local | hosted
placement_id

managed_relative_path

repository_id
workspace_id
repository_relative_path
branch

status
session_id
archived_at
created_at
updated_at
last_opened_at
last_known_file_version
```

The origin-specific fields form a validated union. A managed entry has one
managed path and no repository locator. A repository entry has repository
identity and relative path and no managed path.

`placement_id` identifies the local device root, hosted user root, or hosted
workspace needed to resolve that locator. It is not a session or VM identity.

`display_name` is index metadata. The Markdown file remains the authority for
document content. The list API returns only index summaries.

### Storage layout

Managed files use stable document identity rather than a user-editable title as
their physical identity:

```text
CLAXEDO_HOME/documents/<project-id>/<document-id>/<slug>.md
CLAXEDO_HOME/document-history/<document-id>/<version>.md
```

Repository documents remain at their repository-relative paths:

```text
<workspace-checkout>/<repository-relative-path>.md
```

Managed history files are immutable, service-owned operation snapshots outside
the agent-writable document directory. They support diff, undo, and exact
downstream handoff without becoming a mutable document authority. Repository
history comes from Git. Claxedo may retain bounded recovery snapshots for
uncommitted human or agent operations and removes them after the configured
recovery window.

### Document workspace service

One server-side service owns document resolution and file mutation:

```text
resolve(indexEntry) -> DocumentHandle
read(handle) -> { markdown, version, modifiedAt }
write(handle, { markdown, expectedVersion, actor }) -> WriteResult
checkout(handle, { jobId }) -> { path, baseVersion }
commitCheckout(handle, { path, baseVersion, actor }) -> WriteResult
moveToRepository(handle, destination) -> DocumentIndexEntry
archive(indexEntry) -> DocumentIndexEntry
```

`DocumentHandle` contains an authorized workspace and canonical path. Paths are
resolved below the managed documents root or authorized repository root.
Symlinks are accepted only when their resolved targets remain inside that root.

The version token is opaque to clients. A local implementation may use content
hash and filesystem evidence; a hosted implementation may use a storage version
or ETag. All writes compare the expected token immediately before atomic
replacement.

### Editor contract

Opening a document is a two-step contract:

1. Fetch the index summary and origin state.
2. Read the current Markdown and opaque file version from the document workspace.

Saving sends Markdown and the expected version. The response returns the new
version and updated summary metadata. Tiptap JSON never crosses the persistence
API.

One persistence controller owns title and Markdown changes, serialization,
retry, conflict state, recovery drafts, and flush-before-action behavior. The
editor consumes that controller rather than implementing save timers directly.

### Agent contract

Agents work with ordinary paths. Claxedo supplies a concise system context that
identifies the document path and document intent. Existing filesystem and shell
permissions remain authoritative.

An agent document operation is bracketed by the document workspace:

1. Flush the human editor.
2. Acquire the document mutation slot.
3. Use Files SDK to record the starting version and download the selected
   document into the job's temporary directory.
4. Run the agent against that ordinary temporary file.
5. Read and validate the resulting Markdown.
6. Commit the complete file against the starting version and record the ending
   version, actor, session, and diff metadata.
7. Remove the temporary checkout, release the mutation slot, and refresh the
   editor.

The first milestone deliberately serializes human and agent writes. Durable
multiplayer editing and remote collaboration are separate product capabilities.

### Exact revision consumers

Features such as WorkGraph handoff that require an immutable input create an
exact filesystem snapshot identified by content hash and operation metadata.
They consume that snapshot; they do not create another mutable document head.

Arena and accepted agent changes ultimately write through the same document
workspace boundary as human changes.

### Hosted operation

The hosted product preserves the same paths-and-index mental model:

- each signed-in account or anonymous installation may have a logical Claxedo
  root backed by durable object or blob storage such as R2 or S3,
- a managed document uses a stable key below that root and remains durable
  independently of a particular VM,
- repository workspaces preserve uncommitted document changes until commit or
  explicit discard,
- reopening an index entry restores or locates its workspace before resolving
  the file,
- agents receive a normal or virtual filesystem path with the same document
  contract,
- the index remains durable independently of any agent session.

The browser editor reads and writes hosted managed documents through the
document service. A cloud agent operation materializes the current version at a
stable path inside its VM, records the base version, lets the agent use ordinary
filesystem tools, and conditionally persists the resulting file to the hosted
root. The VM copy is an operation checkout, not a second authority. A failed or
terminated operation leaves the last committed hosted version intact.

The first hosted milestone persists at the operation boundary: hydrate, edit,
validate, and conditionally commit. Periodic write-through and offline desktop
mirroring require a separate synchronization design and are not implicit in
this contract.

### Lazy hosted working sets

The hosted Claxedo root is a logical namespace and is never cloned wholesale to
a desktop or cloud VM.

- The Documents index is a server-side, cursor-paginated metadata index.
- Title, path, project, origin, and status search runs against index metadata
  without downloading Markdown bodies.
- Opening a document hydrates only that document at its exact version.
- Starting an agent operation hydrates the target document and only the context
  documents explicitly selected by the user or agent.
- An agent can search the remote index and request another document; that
  document then appears as an ordinary file in the operation working set.
- Hydrated files use a bounded cache keyed by document identity and version.
- Clean files may be evicted by least-recent use. Dirty files remain pinned
  until their conditional write succeeds or the operation is explicitly
  discarded.
- A cache entry is never presented as current after the remote version changes.

The first implementation uses explicit search and hydrate operations around an
ordinary sparse working directory. A later filesystem mount may translate
directory listing and file-open operations into the same APIs, but the product
contract does not depend on FUSE, a particular VM provider, or a complete local
mirror.

Files SDK is the managed-document discovery and transfer abstraction:

- local managed documents use its filesystem adapter below the local Claxedo
  root,
- hosted managed documents use its R2 or S3 adapter below the hosted Claxedo
  root,
- `search` and `list` discover keys and paths,
- `head` records the selected document's starting version evidence,
- `download` copies only selected documents into the job temporary directory,
- `upload` writes the complete edited Markdown back after Claxedo validates the
  expected version.

No remote patch method is assumed. Agents patch the temporary ordinary file;
the operation commits the resulting complete document. Files SDK key search is
not a full-text Markdown index, so cross-document content search remains a
Claxedo index capability.

For local unsigned cloud execution, Files SDK operations are served by the
connected local Claxedo app through the cloud relay. For hosted signed
execution, the hosted document service invokes Files SDK directly. The agent
receives neither local filesystem access outside the selected documents nor raw
object-storage credentials.

Using a cloud VM from the local app does not require user sign-in. The local
installation holds a durable installation credential and requests a short-lived
job capability scoped to the document checkout, workspace, and allowed
operation. This is capability-authenticated cloud execution, not an open
unsigned network endpoint. Storage credentials remain in the document service
or VM sidecar and are not exposed to the agent process or model context.

just-bash may provide a constrained filesystem editing environment when a full
workspace shell is unnecessary. Files SDK and just-bash do not own document
identity, expected-version checks, operation history, or Git transitions.

## Required UX

### Documents index

The index provides:

- New managed document,
- Add repository Markdown,
- server-side title and path search, project filtering, and cursor pagination,
- managed or repository origin label,
- repository path and branch when applicable,
- modified time and document availability,
- dirty, agent-working, conflicted, or archived state when applicable,
- archive and restore,
- automatic recovery after event-stream interruption.

The index never downloads Markdown bodies to render the list.

### Document workspace

The document workspace provides:

- one title and save indicator,
- rich or lossless source editing according to Markdown support,
- agent instruction and operation progress,
- exact before/after diff for agent operations,
- operation history and undo,
- managed-path or repository-path context,
- explicit errors for missing and unavailable files,
- keyboard-accessible recovery and conflict actions.

Repository documents additionally provide working-tree diff and Git actions.
Managed documents provide **Move to project** and **Export snapshot**.

## Clean Replacement Rules

- Reset the development Pages database and install the target index schema
  directly.
- Delete `claxedo_page.content` and database revision-body authority.
- Delete import/export synchronization semantics that maintain Page and file
  copies.
- Delete lazy binding, legacy Page repair, dual reads, backfills, and migration
  compatibility specific to existing Pages data.
- Delete visibility variants and route behavior that the product does not expose.
- Preserve reusable editor, route, authorization, workspace, Git, and agent UI
  components only after adapting them to the filesystem contract.
- Tests define only target behavior. Existing tests for removed contracts are
  deleted or rewritten rather than preserved as compatibility requirements.

## Implementation Sequence

### M1. Make the current surface dependable

- start the Claxedo server in the standard local workflow,
- correct organization and project authorization,
- add runtime request schemas and limits,
- reconnect index invalidation streams,
- replace immediate delete with archive and restore,
- establish browser coverage for create, open, edit, close, and reopen.

### M2. Replace content storage with filesystem documents

- reset the Page schema to the document index record,
- implement managed document creation and durable layout,
- implement repository document indexing without content import,
- add the document workspace read and expected-version write contract,
- add Files SDK-backed search, versioned single-document checkout, complete-file
  commit, and bounded working-set caching,
- return metadata-only index summaries,
- remove Page content and competing document-head writes.

### M3. Make editing lossless and recoverable

- make Markdown the editor API contract,
- define and test the lossless rich-editor subset,
- add source mode for unsupported Markdown,
- implement the serialized persistence controller,
- flush before close and every content-consuming action,
- expose retry, conflict, and browser-local recovery drafts.

### M4. Align agents and Git with the same file

- run agent operations against the resolved canonical path,
- let agents search the remote index and hydrate additional context documents
  into the operation working set,
- serialize human and agent mutations,
- record operation snapshots and show exact diffs,
- provide undo through a new filesystem operation,
- show repository working-tree state,
- commit repository documents without content conversion,
- implement managed-to-repository ownership transition.

### M5. Restore secondary Pages capabilities

- adapt status, session attachment, Arena, and WorkGraph handoff to index entries
  and exact filesystem snapshots,
- keep each secondary capability outside the editor persistence lifecycle,
- retain only capabilities that do not introduce another mutable content store.

M1 and M2 establish the product architecture. M3 and M4 complete the core
human-agent workflow. M5 follows after the primary loop is verified.

## Acceptance Criteria

1. A managed document can be created, edited, closed, and reopened after a
   process restart without entering a Git repository.
2. An existing repository Markdown file can be indexed without copying its body
   into the database.
3. The Documents index lists both origins without fetching Markdown content.
4. Opening one document in a large hosted collection transfers that document,
   not the complete Claxedo root.
5. Opening either origin resolves exactly one canonical filesystem path.
6. Human edits persist as UTF-8 Markdown and rapid title/body changes cannot
   race or disappear.
7. Save failure and version conflict preserve the local draft and remain visible
   until resolved.
8. Supported Markdown preserves meaning across rich-editor open and save;
   unsupported constructs remain byte-preserved in source mode.
9. Starting an agent action flushes human edits, edits the canonical file, and
   returns an exact before/after diff.
10. An agent can search and hydrate another remote document without downloading
    unrelated document bodies.
11. Human and agent writes cannot run concurrently in the first milestone.
12. Undo restores a previous file snapshot as a new operation.
13. Repository documents expose filesystem diff and commit the current file
    without exporting from a database body.
14. Moving a managed document into a repository changes its origin and leaves
    one authoritative file.
15. Documents remain findable independently of their last agent session.
16. A local installation can send a local document operation to a cloud VM
    without user sign-in; the result returns through an installation-scoped job
    capability and the canonical document remains local.
17. A hosted managed document survives VM replacement and a cloud agent can
    conditionally commit an operation checkout without receiving storage
    credentials.
18. Opening a hosted document on desktop does not silently create a second
    authoritative local document.
19. Bounded cache eviction never removes a dirty document operation checkout.
20. Local startup, server, editor, index, repository, and hosted-resolution tests
    pass from their owning packages.
21. The replacement contains no Pages data migration, legacy binding,
    compatibility read, or dual-write path.

## Scope Boundaries

This plan covers private human-agent Markdown authoring and repository commit
workflows.

Out of scope and tracked separately:

- public sharing and `*.claxedo.com` publishing,
- anonymous reviewer identity,
- comments and durable comment threads,
- multiplayer editing,
- website annotation,
- Notion, Google Docs, or other document-provider conversion,
- automatic two-way synchronization between managed and repository documents.
- automatic bidirectional synchronization between local and hosted Claxedo
  roots.
