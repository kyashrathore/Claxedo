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

- R19. **Ask agent** uses a normal Claxedo agent session with the document
  supplied as context. The document does not own a chat or transcript.
- R20. Agent execution starts only after a conflict-free flush of the exact
  visible draft. A failed or conflicting flush keeps the document editable,
  preserves the draft, exposes recovery, and does not start the agent.
- R21. The active document becomes temporarily read-only while an agent is
  changing it. Other documents and tasks remain usable.
- R22. The agent edits a short-lived filesystem operation copy created from the
  last successful flush. On successful completion, Claxedo automatically and
  atomically applies the resulting patch only when the authoritative file still
  matches that starting version. A version mismatch becomes a conflict and
  never overwrites the newer file.
- R23. Every terminal agent outcome—success, failure, cancellation,
  interruption, or session loss—clears the read-only state and rereads the
  authoritative file. Success shows a changed or unchanged result and a diff
  against the last successful pre-agent flush. An unsuccessful operation does
  not modify the authoritative file.
- R24. Before applying an agent change, Claxedo persists a recovery checkpoint
  of the authoritative file. The checkpoint survives closing or restarting the
  editor and can restore the document after a bad agent change. Applied agent
  changes also participate in the active editor's ordinary undo/redo history,
  and undo autosaves the reverted content.
- R25. If applied agent output falls outside the rich-editing contract, Claxedo
  preserves the exact bytes, shows the diff, and transitions the document to
  labeled source mode without losing undo for the active editor session.
- R26. Ending, replacing, or losing an agent session has no effect on document
  identity or availability. A later session can continue from the current file.

**Milestone progression**

- R27. A follow-up local lifecycle milestone allows a managed document to move
  into a repository while keeping its Claxedo identity and making the
  repository file its sole content authority.
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
- An agent starts from flushed content, edits an ordinary temporary file, and
  applies its completed change only when the authoritative file still matches
  the starting version. Every terminal outcome unlocks the editor.
- A user can ask for an agent change, inspect and undo the result, give a
  follow-up instruction in the normal session, and continue human editing
  without changing document identity.
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
- General-purpose version history and document-owned AI conversations are
  outside milestone one. Milestone one retains targeted recovery checkpoints
  for automatically applied agent changes.
- Repository-wide Markdown discovery is outside scope; indexing is explicit.
- Moving a managed document into a repository is a follow-up local lifecycle
  capability and does not block milestone one.
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
- Agent changes apply automatically from an isolated filesystem operation copy
  and remain recoverable through a persisted pre-change checkpoint, a diff, and
  editor undo rather than an acceptance workflow.
- Agent mutation is serialized with human editing in milestone one. Concurrency
  arrives with the collaboration capability that requires it.

## Dependencies / Assumptions

- The supported Markdown contract and source-fallback detector will be validated
  against representative and adversarial Markdown fixtures with no known false
  negatives before repository files are eligible for rich editing rather than
  source mode.
- Each deployment can provide agents filesystem-compatible access to a
  short-lived operation copy and conditionally write the result to the correct
  durable backend.
- Unsigned cloud-agent access depends on a reachable local Claxedo application
  capable of brokering scoped document access for that operation.

## Outstanding Questions

### Deferred to Planning

- [Affects R2, R7-R11][Technical] Define the common storage interface, local and
  hosted backends, index persistence, scoped cloud-agent bridge, lazy
  materialization, and conditional write protocol.
- [Affects R9][Technical] Choose whether each agent runtime uses a configurable
  Git-ignored projection, virtual filesystem commands, temporary copies, or a
  combination.
- [Affects R14][Technical] Define the supported Markdown corpus, fallback
  detection, and source editor implementation.
- [Affects R22][Technical] Define the operation-copy lifecycle, expected-version
  check, atomic file replacement, external-change detection, and diff
  integration at the filesystem boundary.
- [Affects R6][Technical] Define missing-file and externally moved-file recovery
  for indexed repository documents.

## Next Steps

→ `/prompts:ce-plan` for structured implementation planning
