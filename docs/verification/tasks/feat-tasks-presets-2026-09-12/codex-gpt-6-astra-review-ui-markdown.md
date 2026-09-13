The range `705d912351..7b67f20d2d` is **not ready to merge**. I found two markdown-loss paths, a reproducible paste regression, and three task UI defects. These findings concern this range only; earlier Tasks/Presets implementation is excluded. Detector and route tests passed, but the mounted Vitest suites were blocked by the read-only environment.

1. **P1 — Markdown paste silently drops unsupported content** — [markdown-paste.ts:44](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:44)

   Pasting plain-text markdown containing `<!-- required instruction -->` bypasses the detector and goes directly through the markdown parser. I invoked the production `handlePaste`: it returned `true`, but the comment disappeared from the serialized markdown. This affects existing Documents files as well as Tasks.

   **Fix:** check representability before consuming the paste. Preserve unsupported input through the ordinary literal-text paste path. Test the actual plugin and resulting markdown; the current tests exercise only `markdownFromPaste`, so they cannot catch this loss.

2. **P1 — External description replacements bypass the fidelity gate** — [tasks-prose-editor.tsx:25](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/app/integrations/tasks/tasks-prose-editor.tsx:25)

   `admitted` captures the initial prop outside tracking, while `rich()` forwards every later value without checking it. Open a supported description, then receive a refetch containing an HTML comment: `RichMode` parses the replacement despite the detector classifying it as source. The comment disappears visually, and the next prose edit serializes and saves its removal. `setContent` succeeds, so serialization-error recovery does not help.

   **Fix:** distinguish editor-emitted updates from external replacements and revalidate external values before applying them. Reset admission when the record identity changes. Keep ordinary keystrokes from switching modes. Add replacement/refetch coverage; initial-mount tests miss this path.

3. **P2 — Ordinary inline paste splits the surrounding paragraph** — [markdown-paste.ts:47](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:47)

   With the caret after `hello ` in `hello world`, pasting `nice ` produces:

   ```text
   hello

   nice

   world
   ```

   I reproduced this through the production paste handler. `parse()` returns a document, and `insertContent(parsed)` inserts its block structure rather than fitting a clipboard slice into the selection.

   **Fix:** insert a context-aware ProseMirror slice, with inline paragraph content fitted into the current textblock. Test mid-paragraph insertion and selection replacement alongside headings and multiline paste.

4. **P2 — “Create a preset” from a row opens nothing** — [tasks-view.tsx:121](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/ui/tasks-view.tsx:121)

   With no presets, open a row’s Start menu and choose “Create a preset.” The handler only writes `presetDraft`; `TasksView` renders no draft editor, and `TasksSurface` remains on the task list. The menu closes without presenting the required creation flow. The control test passes because it checks only that a mock callback ran.

   **Fix:** create the draft and navigate through `onOpenPresets()`, where `PresetDraftEditor` already owns this flow. Test the complete surface transition and editor appearance.

5. **P2 — Rows open deleted sessions and cannot restart their slot** — [start-task.ts:103](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/start-task.ts:103), [start-task.ts:79](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/start-task.ts:79)

   After a linked session is deleted, its link count still makes the row offer Open. `openLatestSession` receives authoritative liveness but ignores it and navigates to the deleted session. Choosing the slot through the caret does not recover: `startNow` always requests attempt `1`, while `checkAttempt` requires the next attempt for a deleted session.

   **Fix:** resolve the current slot from the detail read, honor its liveness, and use the same attempt-selection policy as task detail. Offer restart when appropriate instead of navigating to a known-deleted session.

6. **P2 — Default subtask progress excludes completed children** — [tasks-view.tsx:67](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/ui/tasks-view.tsx:67)

   A parent with one completed child and one unfinished child displays `0/1` in the default Active collection. Progress is calculated from `visible()`, which already excludes completed tasks. Pagination and status filters can further reduce the denominator, so this is not the parent’s completion progress.

   **Fix:** obtain authoritative child totals independent of the displayed collection and page. Until those totals are available, omit the progress fraction.

Things checked and found sound:

- Documents still defaults to exact detection; normalizing mode is explicitly selected by Tasks.
- Mounting does not itself serialize the description; external `setContent` suppresses update emission. The loss in finding 2 occurs on a subsequent prose edit.
- Production probes preserved surrounding text with inline images and correctly converted links and `1)` lists.
- Native selects retain labels, disabled semantics, and focus styles. The create dialog reuses the named Kobalte dialog.
- The new window listeners have cleanup handlers; preset synchronization uses `on(...)` to avoid tracking its store writes.
- Link-count queries retain scope filtering.

Validation from `packages/claxedo-app`:

```sh
bun test --conditions=browser --preload ./happydom.ts ./src/features/documents/markdown/detector.test.ts ./src/platform/identity/route.test.ts ./src/app/workbench/state/surface-route.test.ts
```

**64 passed, 0 failed.**

```sh
bunx --no-install vitest run --config vitest.config.ts src/app/integrations/tasks/tasks-prose-editor.vitest.tsx src/app/integrations/tasks/tasks-markdown-shortcuts.vitest.tsx src/features/documents/editor/markdown-paste.vitest.tsx src/features/tasks/ui/task-start-control.vitest.tsx
```

**Blocked before execution:** Vite’s temporary config write failed with `EPERM`. Mounted UI acceptance remains unverified.