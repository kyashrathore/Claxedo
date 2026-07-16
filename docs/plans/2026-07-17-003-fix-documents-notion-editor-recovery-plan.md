---
title: "Notion Documents editor stability — Implementation Plan"
type: fix
date: 2026-07-17
origin: docs/plans/2026-07-16-001-feat-documents-core-implementation-plan.md
related:
  - docs/plans/2026-07-16-002-feat-documents-core-architecture-and-features.md
  - docs/plans/2026-07-15-001-fix-pages-filesystem-documents-plan.md
---

# Notion Documents editor stability — Implementation Plan

## Goal capsule

Deliver the established Notion-style document editing experience while keeping
the new Documents file, API, CAS, autosave, history, and external-change
architecture. Markdown is the editor's input/output format through Tiptap's
Markdown extension; it is not a replacement editor surface.

The release is accepted only when a browser can type, navigate, format, and
autosave directly inside the rich editor without remounting it, moving the
caret, changing modes, losing content, or requiring a human to notice a broken
flow.

## Product contract

### Requirements

- **R1 — Preserve the editor experience.** Supported Markdown opens in the
  established Notion-style shell: ghost title, spacious body, inline slash
  commands, selection toolbar, rich formatting, links, task lists, tables,
  images, Mermaid blocks, and table of contents.
- **R2 — Keep Documents persistence.** The editor reads and writes Markdown
  through `DocumentsApi` and `DocumentPersistenceController`; the legacy Pages
  content API and Tiptap-JSON persistence do not return.
- **R3 — Use Tiptap Markdown as an extension.** The editor includes
  `@tiptap/markdown` in its extension list, initializes with a Markdown string
  and `contentType: "markdown"`, saves with `editor.getMarkdown()`, and applies
  clean external Markdown with Markdown-aware `setContent`.
- **R4 — Keep one editor instance.** Autosave responses, self-generated SSE
  notifications, duplicate notifications, save-status changes, and clean
  external refreshes preserve the mounted Tiptap editor instance and its mode.
- **R5 — Mode is stable.** Rich/source mode changes only from an explicit user
  action or when a newly opened/external document is outside the supported
  rich Markdown contract. A save or self-event never changes mode.
- **R6 — Preserve typing state.** Ordinary input, Enter, Backspace/Delete,
  paste, selection, composition, undo/redo, and toolbar actions keep focus and
  selection in the editor across autosave.
- **R7 — Keep the source safety net.** Unsupported Markdown opens in a labeled
  source editor with the detector's reason and exact bytes. A user may also
  explicitly switch to source. Source-mode tests are separate from rich-editor
  acceptance tests.
- **R8 — Make rich editing the release canary.** The fastest browser gate types
  into the real `contenteditable` ProseMirror surface and waits through real
  autosave/event behavior. It never calls a helper that switches to source.
- **R9 — Make failures machine-detectable.** The canary fails on editor-node
  replacement, focus/selection loss, mode changes, console errors, page errors,
  skipped assertions, retries, stale content after reopen, or missing expected
  Markdown on disk.
- **R10 — Keep the test environment deterministic.** A single package command
  starts the workspace app and an isolated normal local server from source,
  waits for health, runs the Documents canary with one worker and zero retries,
  and cleans up.

### Acceptance journeys

1. Open supported Markdown, click the rich body, type text, press Enter, type a
   second paragraph, delete and retype characters, paste content, and undo/redo.
   Wait through two autosave cycles. The same DOM node remains mounted, the
   editor stays focused in rich mode, the caret remains valid, and reopening
   yields the saved content.
2. Select text and exercise the floating toolbar: bold, italic, underline,
   highlight/color, and link. Invoke `/`, insert a supported block, edit a task
   list, and mutate a table. Markdown persistence and reopen preserve each
   result.
3. Deliver the editor's own `document.changed` before the save response, after
   the save response, and again as a delayed duplicate. Every ordering advances
   version state without replacing the editor or resetting content/selection.
4. Deliver a genuinely external clean update. The same editor instance updates
   in place without emitting a save loop. Deliver a genuinely external update
   while dirty. The local draft remains visible and the conflict UI preserves
   both versions.
5. Open unsupported Markdown. Exact bytes appear in labeled source mode with a
   reason. This journey does not count as rich-editor proof.
6. Run the same direct-rich typing/autosave/reopen canary against the normal
   local server and filesystem, not only the mock-backed browser runtime.

## Planning contract

### Fixed decisions

- **KTD1 — The Notion editor is the presentation baseline.** Use the UI
  and interactions from `115def4fbf^` under
  `packages/claxedo-app/src/features/documents/editor/`, adapting them to the
  Documents controller instead of recreating them from memory.
  `(session-settled: user-directed — the existing editor is retained and
  Markdown support is added underneath it.)`
- **KTD2 — Tiptap owns Markdown translation while editing.** The installed
  `@tiptap/markdown@3.23.4` extension is the rich editor's parser/serializer.
  The detector remains an eligibility/fidelity gate and source-mode router; it
  is not a parallel rich editor implementation.
- **KTD3 — Persistence state cannot own view mode.** Mode is explicit editor
  state. Version acknowledgements and self-events update persistence metadata
  only. A different external byte sequence may update content or enter
  conflict, but cannot silently select another mode.
- **KTD4 — Direct rich interaction is tier zero.** Unit and source-mode tests
  are supporting evidence. A direct browser interaction with ProseMirror is
  the first and mandatory release gate.
- **KTD5 — The implementation keeps current scope boundaries.** The Documents API, file
  authority, history, CAS, source fallback, and selection quick-action seam
  remain. The legacy SQLite content authority, Pages update API, Arena dock,
  and whole-document legacy AI coupling stay outside this recovery.

## Implementation units

### F0 — Add failing rich-editor canaries first

Create the executable contract before changing the editor.

**Files**

- `packages/claxedo-app/e2e/playwright/documents-rich-editor.spec.ts`
- `packages/claxedo-app/src/features/documents/editor/document-editor.vitest.tsx`
- `packages/claxedo-app/src/features/documents/editor/rich-editor.vitest.tsx`

**Work**

- Add a focused component test that mounts a supported document, obtains the
  actual ProseMirror node, types through browser-like input, advances fake
  timers through autosave, injects self-events in all three orderings, and
  asserts one editor instance, one mode, and preserved selection.
- Add a dedicated Playwright spec with no source-mode helper. Store a
  `JSHandle` to the `contenteditable` node and compare node identity after
  autosave. Assert `document.activeElement`, browser selection containment,
  rich-mode visibility, saved Markdown, and reopen content.
- Add a second canary for floating toolbar plus slash-command behavior. It must
  fail against the current minimal replacement for missing parity, even if
  plain typing happens to pass.
- Register `pageerror`, `console.error`, and unhandled request failures as test
  failures before opening the document.

**Exit gate**

- The canaries fail for the observed missing/broken behavior for specific
  assertions, not from environment startup or a loose timeout.

### F1 — Restore the Notion editor shell and extension set

Recover proven UI code from the pre-replacement baseline and remove its legacy
business dependencies at the adapter boundary.

**Files**

- `packages/claxedo-app/src/features/documents/editor/notion-editor.tsx`
- `packages/claxedo-app/src/features/documents/editor/notion-editor.css`
- `packages/claxedo-app/src/features/documents/editor/notion-editor-tiptap.ts`
- `packages/claxedo-app/src/features/documents/editor/notion-editor-toolbar.tsx`
- `packages/claxedo-app/src/features/documents/editor/notion-editor-geometry.ts`
- `packages/claxedo-app/src/features/documents/editor/notion-editor-toc.tsx`
- adapt `mermaid-block.ts`, `mermaid-keyboard.ts`, and `slash-commands.tsx`

**Work**

- Recover the ghost-title/body layout, placeholder, ProseMirror styling,
  floating selection toolbar, menus, selection geometry, and TOC behavior from
  `115def4fbf^`.
- Recover StarterKit, Link, Underline, Highlight, TextStyle, Color, Image,
  Table, TableRow, TableHeader, TableCell, TaskList, TaskItem, Mermaid, and
  slash-command extensions.
- Expose a narrow adapter:
  `{ markdown, displayName, onMarkdownChange, onDisplayNameChange, onBlur,
  onExplicitSourceMode, onSelectionAction }`.
- Keep save status, history, conflict recovery, navigation, and Documents API
  ownership in `document-editor.tsx`; keep editor mechanics in the restored
  Notion component.
- Preserve accessible names for the rich body, title, floating toolbar, menus,
  and source-mode action.

**Exit gate**

- The parity canary sees and operates the recovered shell and interaction
  controls. Component tests cover keyboard focus from title to body and scoped
  select-all.

### F2 — Wire Markdown through the Tiptap extension

Replace the parallel JSON conversion path in the rich editor with Tiptap's
Markdown extension while retaining the detector's fidelity gate.

**Files**

- `packages/claxedo-app/src/features/documents/editor/notion-editor-tiptap.ts`
- `packages/claxedo-app/src/features/documents/editor/notion-editor.tsx`
- `packages/claxedo-app/src/features/documents/markdown/detector.ts`
- `packages/claxedo-app/src/features/documents/markdown/roundtrip.test.ts`

**Work**

- Add `Markdown` to the extension set and initialize the editor with the
  Markdown body string plus `contentType: "markdown"`.
- On editor updates, obtain Markdown with `editor.getMarkdown()`, reattach the
  existing opaque frontmatter envelope, and send one Markdown string to the
  persistence controller.
- For a clean external update, call
  `editor.commands.setContent(markdownBody, { contentType: "markdown",
  emitUpdate: false })` on the existing editor instance.
- Keep frontmatter byte preservation and the supported/unsupported contract in
  `detector.ts`; delete rich-editor use of standalone JSON parse/serialize
  helpers once the extension path has equivalent fixture coverage.
- Add round-trip fixtures for every restored extension, including tables,
  tasks, links, Mermaid, images, nested lists, and formatting marks. Any
  construct without byte-safe Markdown behavior routes to source mode with a
  reason instead of corrupting content.

**Exit gate**

- Supported fixtures are byte-stable under open/edit/save/reopen, unsupported
  fixtures retain exact bytes in source mode, and the rich editor imports the
  `Markdown` extension directly.

### F3 — Make autosave and external events editor-stable

Define one synchronization path between the mounted editor and the persistence
controller.

**Files**

- `packages/claxedo-app/src/features/documents/editor/document-editor.tsx`
- `packages/claxedo-app/src/features/documents/editor/external-change.ts`
- `packages/claxedo-app/src/features/documents/state/persistence-controller.ts`
- adjacent component/controller tests

**Work**

- Mount the rich editor once per `{document.id, explicitMode}`. Do not key or
  recreate it from version, save state, SSE reason, or detected document JSON.
- Classify events using document id, content hash/version, base version, and
  dirty state:
  - self acknowledgement or same bytes: advance expected version only;
  - clean different bytes: update the existing editor with `emitUpdate: false`;
  - dirty different bytes: enter conflict and preserve the local draft;
  - unsupported different bytes while clean: preserve the current version for
    recovery, then show labeled source mode as an explicit external-contract
    transition.
- Ensure programmatic content application cannot schedule an autosave or feed
  another SSE loop.
- Preserve the current selection where the update is byte-identical. For a
  clean different-byte refresh, map/clamp the selection and refocus only if the
  editor owned focus before the refresh.
- Keep explicit source/rich choice separate from detection recomputation.

**Exit gate**

- Component tests pass the full event-order matrix. The direct browser canary
  retains node identity, focus, selection, mode, and content through two
  autosaves and delayed duplicate events.

### F4 — Restore interaction parity without legacy persistence coupling

Finish the user-visible behaviors that distinguish the Notion editor from a
plain contenteditable.

**Files**

- restored `notion-editor-*` modules
- `packages/claxedo-app/src/features/documents/editor/document-editor.tsx`
- focused interaction tests beside each module

**Work**

- Restore ghost-title behavior, body placeholder, floating toolbar placement,
  link popover, formatting menu, table commands, slash commands, task lists,
  images, Mermaid keyboard behavior, TOC navigation, and bottom breathing room.
- Adapt selection quick actions to the current `transformSelection` callback;
  applying an accepted transform becomes an ordinary Markdown edit and follows
  the same autosave path.
- Retain current Documents chrome for save state, history, conflict recovery,
  repository metadata, and navigation.
- Add keyboard and accessibility assertions for title→body focus, toolbar focus
  retention, Escape behavior, announcements, and contenteditable role/name.

**Exit gate**

- Every R1 interaction has a named component or Playwright assertion. No
  requirement is closed by a screenshot alone.

### F5 — Install the fast release gate and run broad proof last

Make the broken-human-editor class of regression fail before the broad suite.

**Files**

- `packages/claxedo-app/package.json`
- `packages/claxedo-app/playwright.config.ts`
- `packages/claxedo-app/e2e/playwright/documents-rich-editor.spec.ts`
- `packages/claxedo-app/e2e/playwright/documents-core.spec.ts`
- CI workflow that runs Claxedo app checks

**Work**

- Add a deterministic Documents preparation command using the Turbo workspace
  graph to build every runtime package required by the normal app/server. The
  command owns startup, readiness, teardown, and artifact paths.
- Add `test:e2e:documents:canary`: Chromium, one worker, zero retries, direct
  rich-editor spec only. CI treats skipped or flaky-retried canaries as failure.
- Run two tiers in order:
  1. mock-backed browser canary for precise event ordering;
  2. normal local server/filesystem canary for real typing, autosave, and reopen.
- Keep source-mode persistence journeys in `documents-core.spec.ts`, but rename
  annotations so they cannot be presented as rich-editor proof. Migrate each
  supported-document human journey to direct rich interaction.
- Run the full Documents suite only after both canaries pass. Capture trace,
  screenshot, and video on failure; assertions remain the authority.

**Exit gate**

- A clean checkout can run one command and either receive a direct-rich pass or
  a specific automated failure. No manual dependency build, source-mode detour,
  visual guess, or retry is needed to get a result.

## Verification contract

Run from `packages/claxedo-app`; never run tests from the repository root.

| Order | Gate | Required proof |
| --- | --- | --- |
| 1 | Focused editor tests | `document-editor`, rich editor, Markdown fixtures, and persistence/external-event matrix pass with fake timers and no skipped cases. |
| 2 | App typecheck | `bun typecheck` passes from `packages/claxedo-app`. |
| 3 | Mock browser canary | Direct ProseMirror typing, formatting, autosave orderings, node identity, focus, selection, mode, saved bytes, and reopen pass with one worker and zero retries. |
| 4 | Local live canary | Normal local server and filesystem pass the same direct typing/autosave/reopen contract after deterministic prerequisite preparation. |
| 5 | Full Documents browser suite | Persistence, source fallback, conflicts, history, index, agent live edit, and hosted journeys pass after the rich canaries. |
| 6 | Hygiene | `git diff --check`; no legacy Pages content API/Tiptap-JSON persistence imports; no console/page errors; no focused/skipped tests. |

### Mandatory canary assertions

- The target is `.ProseMirror[contenteditable="true"]` with accessible name
  `Document rich editor`.
- A retained `JSHandle` compares equal to the post-autosave DOM node.
- `document.activeElement` is the editor and the browser selection anchor is
  inside it after each autosave/event boundary.
- The page never renders the source-mode label during the supported-document
  journey.
- The exact typed/formatted semantic content exists in persisted Markdown and
  after reopen.
- Save response/SSE order permutations and delayed duplicate SSE all run.
- `pageerror`, `console.error`, unhandled network failure, skip, retry, or test
  timeout fails the gate.

## Fast execution sequence

1. F0: make the direct-rich and parity canaries fail for the right reasons.
2. F1 + F2: recover the proven editor shell and connect the Markdown extension.
3. F3: close the autosave/SSE feedback loop until node/focus/mode assertions pass.
4. F4: close the remaining interaction-parity assertions.
5. F5: prove the local live path, then run the full Documents suite and app
   typecheck.

Broad E2E execution does not begin while the direct rich canary is red. This
keeps the feedback loop short and prevents unrelated suite coverage from
masking a broken editor.

## Definition of done

- [ ] Supported Markdown opens in the restored Notion-style editor.
- [ ] `@tiptap/markdown` is an installed editor extension and the rich path
      reads/writes Markdown through Tiptap.
- [ ] The legacy Pages content API and Tiptap-JSON persistence are absent.
- [ ] Rich typing, Enter, delete, paste, undo/redo, selection, and formatting
      work through at least two autosave cycles.
- [ ] Autosave/self-SSE permutations preserve editor node, mode, focus,
      selection, and content.
- [ ] Clean external updates apply in the same editor instance; dirty updates
      preserve the draft and show truthful conflict recovery.
- [ ] Ghost title, slash commands, selection toolbar, links, tasks, tables,
      images, Mermaid, TOC, and selection quick actions have behavior tests.
- [ ] Unsupported Markdown preserves exact bytes in labeled source mode.
- [ ] Mock and normal-local direct-rich canaries pass with zero retries.
- [ ] `bun typecheck`, focused tests, full Documents E2E, and hygiene gates pass.
- [ ] Recorded evidence is reviewed only after the automated interaction gates
      pass; a human is not the first detector of editor usability regressions.
