**Not ready to merge.** At `d4603a6f5b`, four prior findings are closed and two are partially closed. The fix round still permits markdown loss through pasted frontmatter and stale editor admission, and introduces regressions in block paste and secondary-slot navigation. Store conformance checks passed across memory, SQLite and D1; mounted UI suites remain unverified because Vite’s temporary-config write failed with `EPERM`.

| Prior finding | Status | Evidence |
|---|---|---|
| P1: Markdown paste drops unsupported content | **Partially closed** | [markdown-paste.ts:28](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:28) rejects ordinary HTML comments, which the default paste path preserves as literal text. Frontmatter escapes that check but is subsequently parsed, still losing comments. |
| P1: External description replacements bypass fidelity gate | **Partially closed** | [tasks-prose-editor.tsx:29](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/app/integrations/tasks/tasks-prose-editor.tsx:29) re-detects ordinary replacements. However, `emitted` survives external replacements, allowing an earlier textarea value to inherit a later value’s rich admission. |
| P2: Inline paste splits the paragraph | **Closed** | [markdown-paste.ts:58](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:58) fits inline content into the selection. The production handler now produces `hello nice world`; block formatting has a separate regression below. |
| P2: Create a preset opens nothing | **Closed** | [tasks-view.tsx:109](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/ui/tasks-view.tsx:109) opens the draft and navigates to Presets, where the existing editor renders it. The added test checks editor appearance, not merely callback invocation. |
| P2: Deleted sessions open; their slots cannot restart | **Closed** | [start-task.ts:80](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/start-task.ts:80) derives the next attempt from detail, and [start-task.ts:112](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/start-task.ts:112) navigates only to a live session. The new primary-only selection causes a distinct regression below. |
| P2: Subtask progress excludes completed children | **Closed** | [tasks-view.tsx:61](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/ui/tasks-view.tsx:61) reads authoritative `children` counts. All three stores count unarchived children independently of the displayed page and status filter. |

**New findings, ordered by severity**

1. **P1 — Pasted frontmatter bypasses representability checking.**  
   [markdown-paste.ts:28](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:28), [markdown-paste.ts:50](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:50)

   Pasting `---\nnote: |\n  <!-- required instruction -->\n---\n\nbody` into an existing Documents paragraph passes detection but silently removes the comment. I reproduced this through `EditorView.pasteText`: detection checks the envelope’s body, while the paste handler parses the entire clipboard string.

   **Fix:** make clipboard admission and insertion operate on the same content. For envelope-bearing clipboard text, preserve the whole input literally unless insertion explicitly preserves the envelope; never discard the envelope or parse unchecked bytes. Add a full paste-and-serialization test using this fixture.

2. **P1 — An earlier emitted value can inherit an unrelated replacement’s admission.**  
   [tasks-prose-editor.tsx:25](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/app/integrations/tasks/tasks-prose-editor.tsx:25)

   Start in source mode, edit to `<!-- edited -->`, externally replace it with supported prose, then externally restore `<!-- edited -->`. `emitted` still matches, so the memo retains the supported replacement’s rich detection and sends the comment into `RichMode`; a subsequent edit can save its removal. Evaluating the production memo expression with Solid produced `source → source → rich → rich`, although the final value independently detects as source.

   **Fix:** invalidate the emission marker when accepting an external replacement, or associate the emitted value with its own admission. Add the complete emit–replace–restore sequence; the two new tests exercise its branches separately.

3. **P2 — Maximally opening every pasted block strips its structure.**  
   [markdown-paste.ts:58](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.ts:58)

   With the caret after `hello ` in `hello world`, pasting `# Title` produces `<p>hello Titleworld</p>`; `> quoted` and `- one` similarly lose their block type. Replacing `world` with a two-item list makes its first item ordinary paragraph text. These are production-handler reproductions affecting Documents and Tasks.

   **Fix:** open a lone ordinary paragraph for inline insertion, while preserving explicit heading, quote, list and other block boundaries. Extend [markdown-paste.vitest.tsx:81](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/documents/editor/markdown-paste.vitest.tsx:81): its empty-document fixture cannot expose this regression.

4. **P2 — Row Open no longer opens a task with only a secondary-slot session.**  
   [start-task.ts:107](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/start-task.ts:107)

   Start a secondary configuration without running Primary, return to the list, and press Open. The row offers Open because its link count is positive, but `TasksView` supplies no slot and the new default examines only Primary, reporting “no session to open” despite a live secondary session. The previous implementation selected an existing group when Primary was absent.

   **Fix:** resolve the row’s session from authoritative live slot groups, preserving Primary preference and handling secondary-only tasks explicitly; then apply `slotAttempt` to that selected slot. Add a secondary-only surface test.

5. **P2 — The restart regression test can pass when no restart happens.**  
   [row-start-actions.vitest.tsx:155](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/ui/row-start-actions.vitest.tsx:155)

   Removing the `send(...)` call from `startNow` would leave this test’s assertion satisfied: it checks only the preview request’s attempt. The fixture also returns preview attempt `9` and start-result attempt `2`, accepting a sequence the real service would not produce.

   **Fix:** use consistent preview/start responses, validate the submitted attempt and digest, and await navigation to the newly created session. This establishes recovery through the complete row action.

**Checked and found sound**

- `TaskSummary.children` is populated by both `list` and `listChildren` in all three stores. Scope and archive predicates are correct; decoding requires the new fields.
- The new [conformance case:535](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/conformance/store.ts:535) proves page-independent totals, completed-child inclusion, scope isolation and zero counts. Its page-folding mutant is caught. Coverage still lacks archived-*done* children and UI assertions displaying nonzero progress.
- `slotAttempt` matches `checkAttempt` for missing, live and non-live current links; task detail and row Start reuse it correctly.
- Documents retains exact admission for existing files. Production-extension parity tests passed, and inline-image paste preserved surrounding text and serialized image markup.
- Store adapters reuse `taskSummaryOf` and the SQL adapters share `childCountLookup`; the grouped queries avoid per-row count calls. No additional correctness finding arose from duplicated paths or historical comments.

**Validation**

Exact test commands, run from their respective packages:

```sh
# packages/claxedo-tasks — 16 passed; 23 passed
bun test src/conformance/conformance-teeth.test.ts
bun test src/stores/memory.test.ts

# packages/claxedo-server-core — 27 passed
bun test src/tasks-host/sqlite-store.test.ts

# packages/claxedo-server — 1 passed
bun test src/tasks/d1-store.test.ts -t 'a list row counts every live child'

# packages/claxedo-app — 30 passed
bun test --conditions=browser --preload ./happydom.ts ./src/features/documents/markdown/detector.test.ts ./src/features/documents/markdown/roundtrip.test.ts ./src/features/documents/editor/rich-extensions.test.ts

# Blocked before test execution: Vite temporary-config write, EPERM
bunx --no-install vitest run --config vitest.config.ts src/app/integrations/tasks/tasks-prose-editor.vitest.tsx src/features/documents/editor/markdown-paste.vitest.tsx src/features/tasks/ui/row-start-actions.vitest.tsx
```

Additional in-memory probes exercised the production paste handler, `EditorView.pasteText`, and the production admission-memo expression. No source changes were made.