---
date: 2026-07-16
topic: claxedo-documents-core
---

# Claxedo Documents Core

## Problem Frame

Claxedo needs a durable project document workspace where one human and an agent
can iteratively shape a Markdown document. A Claxedo-managed document must
survive deletion of a checkout, replacement of a workspace, and termination of
a cloud VM. Existing repository Markdown remains owned by its repository. Both
document kinds must be available to agents through filesystem-compatible tools
while Claxedo provides focused writing, intentional indexing, safe autosave,
and clear visibility into agent changes.

The first milestone establishes this single-human workflow locally without an
account. Later milestones promote selected documents into hosted asynchronous
human review and then direct multi-human editing.

## Requirements

**Document identity and ownership**

- R1. Every document belongs to one Claxedo project and has a stable Claxedo
  identity independent of tabs, processes, and agent sessions.
- R2. A Claxedo-managed document is an ordinary Markdown object in
  Claxedo-owned durable storage. Its canonical content does not live inside a
  project checkout or depend on the lifetime of an agent VM.
- R3. An existing repository Markdown file remains at its repository path and
  enters Documents only after the user explicitly selects **Add to Documents**.
- R4. The Documents index stores identity, location, and workflow metadata. It
  does not store a second authoritative copy of document content.
- R5. The Documents index presents managed and repository documents together,
  clearly labels their source and relative path, shows modified and exceptional
  states, and provides primary **New document** and **Add to Documents** actions.
- R6. Closing and restarting Claxedo preserves the project Documents index and
  reopens each available document from its authoritative storage location. A
  missing or externally moved repository file opens an explicit recovery state
  rather than a blank editor.
- R7. In unsigned local mode, Claxedo-managed documents and their index live in
  the user's persistent Claxedo application data on their machine. They remain
  available when a project checkout or cloud VM is deleted.
- R8. In signed-in hosted mode, Claxedo-managed documents and their index live
  in a user- and project-scoped durable storage namespace. Compute instances are
  disposable clients of that storage, not document owners.
- R9. A workspace may expose managed documents through a configurable
  Git-ignored projection directory, virtual filesystem, or temporary working
  copy. Such materializations are caches and agent interfaces; losing one does
  not lose the canonical document.
- R10. Agents discover managed documents through the Claxedo Documents index
  and materialize only the documents they need. The system does not clone every
  managed document into every workspace.
- R11. A cloud agent operating for an unsigned local user receives
  session-scoped access brokered by the running local Claxedo application. A
  cloud VM cannot independently discover the user's local documents when that
  application is unreachable.

**Human editing**

- R12. The primary editing experience is a Notion-like rich editor backed by
  Markdown using the open-source Tiptap editor and `@tiptap/markdown`.
- R13. Rich editing supports a documented UTF-8 CommonMark/GFM dialect plus
  explicitly supported Claxedo extensions. Opening or viewing never rewrites a
  file. The first human mutation in rich mode authorizes serialization of the
  supported document and may normalize Markdown syntax outside the edited
  region without changing its meaning.
- R14. A file outside the supported rich-editing contract opens in a clearly
  labeled, loss-preserving source mode that explains why. Source mode retains
  autosave and **Ask agent**; returning to rich mode requires a compatible file
  and an explicit user action.
- R15. Human changes autosave continuously to the authoritative Markdown
  content.
  The editor exposes unambiguous saving, saved, error, and conflict states.
- R16. An external-change conflict stops autosave and preserves both the visible
  draft and disk content. The recovery flow provides comparison, reload from
  disk, save the draft as a copy, and an explicit confirmed overwrite.
- R17. A failed save preserves the visible human draft and provides an
  actionable retry or recovery path.
- R18. The index, editor, save states, agent-running state, diff, recovery
  actions, and source-mode transition support keyboard operation, predictable
  focus, and assistive-technology announcements.

**Agent editing**

- R19. **Ask agent** uses a normal Claxedo agent session. A document mention or
  discovery result supplies its stable document identity, display name, and an
  honest filesystem path; the document owns neither chat nor transcript state.
- R20. The editor eagerly flushes human edits on blur, tab close, unmount, and
  every content-consuming action. Agent execution has no document-specific
  start gate or read-only lock, so human and agent work can proceed concurrently.
- R21. Agents read and edit ordinary Markdown files with their normal harness
  tools. Repository documents remain at their canonical workspace paths;
  managed documents outside the session filesystem are hydrated individually
  to stable session-local paths with their current opaque base versions.
- R22. Hydrated-document synchronization writes back the complete Markdown file
  conditionally against its recorded base version. Success advances that base;
  a mismatch parks synchronization as conflicted and preserves both the durable
  document and the session draft for explicit human resolution.
- R23. External file changes refresh a clean editor in place. When the editor
  has a local draft, the same change enters conflict recovery with a comparison
  of the external bytes and the preserved human draft. Save-time compare-and-
  swap remains the final lost-update boundary without mutation locks.
- R24. Managed documents receive automatic bounded snapshots around service
  writes and observed external-change boundaries. Repository documents use Git
  history and diffs for recovery; restoring any version is a conditional write
  that preserves newer concurrent work as a conflict.
- R25. Every refresh re-runs the Markdown compatibility detector. Content
  outside the rich-editing contract retains its exact bytes, exposes the
  changed-on-disk diff and recovery history, and opens in labeled source mode
  under the same save, conflict, and external-change contracts.
- R26. Ending, replacing, or losing an agent session has no effect on document
  identity or availability. A later session can continue from the current file.

**Milestone progression**

- R27. The local lifecycle allows a managed document to move into a repository
  while keeping its Claxedo identity and making the repository file its sole
  content authority.
- R28. Milestone two adds hosted asynchronous review: human comments, replies,
  resolution, and document-scoped access.
- R29. Milestone three adds direct multi-human editing and the concurrency model
  required for simultaneous changes.

## Success Criteria

- A user can create a managed project document without signing in, delete and
  recreate the project checkout, restart Claxedo, find the document in the
  project's Documents index, and reopen the exact Markdown content.
- A hosted user's managed document remains available after the cloud workspace
  or agent VM that last edited it has been destroyed.
- A user can explicitly index an existing repository Markdown file and edit it
  in place without a database content copy.
- Opening and closing a supported document without editing produces no file
  change; unsupported Markdown is never silently discarded.
- Human edits autosave with truthful status and remain recoverable after a save
  error or external-change conflict.
- A user can select a document through `/docs`, and an agent can discover its
  honest path and edit it with the session's ordinary filesystem tools.
- A managed session copy writes back only against its recorded opaque base
  version. A concurrent durable change parks the session copy as conflicted and
  preserves both versions for explicit recovery.
- An open clean editor refreshes when an agent changes the document; an editor
  with an unsaved human draft preserves both sides in conflict recovery.
- A user can inspect the resulting diff, give a follow-up instruction in the
  normal session, and continue human editing without changing document identity.
- A user can close and reopen a document after an agent change and still restore
  the pre-agent version.

## Scope Boundaries

- Milestone one supports unsigned local use and signed-in hosted use through the
  same document-storage contract with different durable backends.
- Local managed documents survive application restarts and workspace deletion;
  hosted managed documents survive compute and workspace deletion. Backup from
  local disk loss and cross-device synchronization for unsigned users are
  outside milestone one.
- Remote sharing, comments, review permissions, presence, and multi-human
  editing begin in later milestones.
- Document-owned AI conversations are outside milestone one. Managed documents
  retain bounded snapshot history, while repository documents use Git history.
- Repository-wide Markdown discovery is outside scope; indexing is explicit.
- A managed document can move into a repository through a journaled transition
  that preserves its Claxedo identity and leaves one authoritative file.
- Git hooks and Git LFS are not the durability mechanism. Managed-document
  storage and conditional synchronization are part of the Documents system.
- Pages is pre-release with one development user, so existing Page content may
  be reset. Milestone one has no legacy read path, migration, or compatibility
  period.

## Key Decisions

- Each document has exactly one content authority: Claxedo durable storage for a
  managed document, or the repository file for an indexed repository document.
  Both expose Markdown to humans and agents.
- Tiptap remains the rich editor because Claxedo already has a substantial
  editor experience and the official MIT-licensed Markdown package replaces
  most custom conversion work.
- Semantic Markdown fidelity is the rich-editor contract; source fallback
  protects constructs outside that contract.
- Agents use ordinary repository files or one session-local hydrated managed
  file. Hydrated changes synchronize as conditional whole-file writes and park
  on conflict without overwriting newer durable content.
- Human and agent editing can proceed concurrently. External refresh and
  save-time compare-and-swap preserve both sides at every lost-update boundary.
- Managed recovery uses bounded snapshots around service writes and external
  change boundaries. Repository recovery uses Git history and diffs.

## Dependencies / Assumptions

- The supported Markdown contract and source-fallback detector will be validated
  against representative and adversarial Markdown fixtures with no known false
  negatives before repository files are eligible for rich editing rather than
  source mode.
- Each deployment provides agents filesystem-compatible access either to the
  canonical repository file or to a contained session-local managed file whose
  manifest records the conditional write-back base.
- Unsigned cloud-agent access depends on a reachable local Claxedo application
  capable of brokering scoped document access for that operation.

## Implementation Contract

The storage interface, local and hosted authorities, session materialization,
Markdown subset, repository recovery, watcher behavior, size limits, relay
capabilities, and end-to-end proof strategy are fixed in
`docs/decisions/2026-07-17-documents-core-implementation-answers.md`. The Q8
object-storage and Q14 session-write-back decisions are recorded beside it.

## Next Steps

→ Execute and verify
`docs/plans/2026-07-16-001-feat-documents-core-implementation-plan.md`.
