# Layout Refactor: File Tree Sidebar, Review Tab System, Context Tab

## Goal

Decouple file tree, review panel, and session context from the session page into layout-level constructs:

1. **File tree** moves from `SessionSidePanel` (inside session) to a **sidebar alongside the tab content area** at the group level
2. **Review panel** becomes a **tab** with a dropdown selector for diff modes (session turn, session, uncommitted, vs base, to/from)
3. **Session context** becomes a new **tab type**
4. **Session page** simplifies to just messages + prompt dock (full width)

---

## Current Architecture

```
GroupPanel
├── WorkspaceBar
├── TopTabBar + [Review toggle] [FileTree toggle]
└── GroupContentRenderer
    └── Per-tab: DirectoryScope → SessionPage
                                   ├── Messages + Prompt Dock (left)
                                   └── SessionSidePanel (right)
                                        ├── Review panel (diffs)
                                        ├── File tree (changes/all tabs)
                                        ├── Context tab
                                        └── File viewer tabs
```

Problems:
- File tree, review, context are **session-scoped** (tied to session page lifecycle)
- ~800 lines of side panel integration code in `session.tsx`
- Review panel is a fixed side panel, not a flexible tab
- File tree mixes "changes" and "all files" tabs — confusing UX

## New Architecture

```
GroupPanel
├── WorkspaceBar
├── TopTabBar + [Review dropdown] [FileTree toggle] [Context button]
├── Content area (flex row):
│   ├── GroupContentRenderer (flex-1)
│   │   └── Tabs: session | terminal | review | file | context
│   ├── ResizeHandle
│   └── FileTreeSidebar (right side, toggleable, resizable)
└── ProcessPane overlay
```

---

## Feature 1: File Tree Sidebar

### What changes
- File tree moves from `SessionSidePanel` to a **layout-level sidebar** in `GroupPanel`
- Shows ONLY the workspace file tree — no "changes"/"all" tabs, no diff indicators
- Clicking a file opens it as a `file` tab
- Resizable, width persisted per group

### Layout
```
┌─────────────────────────────────┬──────────────────┐
│                                 │  Files            │
│  Tab Content                    │  ├── src/         │
│  (session/terminal/review/etc)  │  │   ├── app.tsx  │
│                                 │  │   └── ...      │
│                                 │  ├── package.json │
│                                 │  └── ...          │
└─────────────────────────────────┴──────────────────┘
```

### Implementation

**New file: `src/claxedo-ui/components/file-tree-sidebar.tsx`**
- Wraps upstream `FileTree` in `DirectoryScope` (provides `useFile()` context that `FileTree` requires)
- Directory: group's default worktree or active tab's directory
- On file click: `tabs().addFile(dir, path, title)`
- Header: "Files" label
- Resizable via `ResizeHandle` (edge="start" since it's on the right)
- Collapse threshold: auto-close when dragged too narrow

**Modified: `src/claxedo-ui/layouts/rail-layout.tsx` (GroupPanel)**
- Wrap `GroupContentRenderer` + `FileTreeSidebar` in a flex row
- Compute `sidebarDir` from group worktree or active tab directory

**State: `GroupLayoutState.fileTree`**
- `opened: boolean` — toggle visibility
- `width: number` — sidebar width (persisted)
- Remove `tab: "changes" | "all"` — no longer needed

---

## Feature 2: Review Tab with Diff Mode Dropdown

### What changes
- Review button icon changes to a **dropdown** (not a simple toggle)
- Dropdown options for diff comparison modes:
  - **Session turn** — last turn diffs (from `lastUserMessage().summary.diffs`)
  - **Session** — all session diffs (from `sync.data.session_diff[sessionId]`)
  - **Uncommitted** — working tree vs HEAD (`git diff HEAD`)
  - **vs base** — working tree vs merge-base (`git diff $(git merge-base HEAD main)`)
  - **to/from** — arbitrary commit range (user picks two commits)
- Selecting a mode opens/activates a `"review"` tab with that mode
- **Compact dock behavior**:
  - Session / Session turn modes: show the **current session's compact prompt dock** on the tab
  - Other modes (uncommitted, vs base, to/from): show a compact dock backed by a **new session**

### Tab types
The existing `TabReview` component renders diffs + changes file tree. It needs to be extended:
- Accept a `diffMode` prop: `"session-turn" | "session" | "uncommitted" | "vs-base" | "to-from"`
- For session/session-turn: use existing sync data (`sync.data.session_diff`, turn diffs)
- For uncommitted/vs-base/to-from: call git diff APIs via SDK
- Compact dock rendering based on mode

### TabItem extension
```ts
type TabItem = {
  // ... existing fields ...
  reviewMode?: "session-turn" | "session" | "uncommitted" | "vs-base" | "to-from"
  reviewFromRef?: string  // for "to-from" mode
  reviewToRef?: string    // for "to-from" mode
}
```

### Review dropdown (ClaxedoLayout.tsx topBarRight)
Replace the current review toggle button with a dropdown:
```
[v Review]
├── Session turn     (last agent turn diffs)
├── Session          (all session diffs)
├── Uncommitted      (working tree vs HEAD)
├── vs base          (working tree vs merge-base)
└── to / from        (pick commits)
```

Clicking an option:
1. Finds the active session in the focused group
2. Creates/activates a review tab with `reviewMode` set
3. For "session" and "session-turn": uses the active session's diffs
4. For "uncommitted", "vs-base", "to-from": uses git diff API (session-independent)

### Compact dock on review tab
- **Session / Session turn modes**: The review tab includes a compact prompt dock connected to the **current session** (the one whose diffs are shown). This lets the user prompt while reviewing changes.
- **Other modes (uncommitted, vs-base, to-from)**: The review tab creates a **new session** and shows a compact prompt dock connected to it. This allows the user to ask questions about the diff they're viewing.

### Implementation files
- **Modified: `src/claxedo-ui/components/tab-review.tsx`** — Add `diffMode` prop, conditional data source (sync vs git API), compact dock integration
- **Modified: `src/claxedo-ui/ClaxedoLayout.tsx`** — Replace review button with dropdown
- **Modified: `src/claxedo-ui/context/claxedo-layout/types.ts`** — Add `reviewMode`, `reviewFromRef`, `reviewToRef` to TabItem
- **New or modified: `src/claxedo-ui/components/compact-prompt-dock.tsx`** — Ensure it works both with existing session and new session modes

---

## Feature 3: Session Context Tab

### What changes
- New tab type `"context"` added to `TabType`
- `SessionContextUsage` button (currently in session header) creates a context tab instead of opening in the session's internal tab system
- Context tab wraps upstream `SessionContextTab` component (already prop-driven)

### Implementation

**New file: `src/claxedo-ui/components/tab-context.tsx`**
- `TabContext` component accepting `sessionId` prop
- Uses `useSync()` (from `DirectoryScope`) to get messages, session info
- Passes data to upstream `SessionContextTab` as props

**Modified: `src/claxedo-ui/components/group-content-renderer.tsx`**
- Add `<Match when={t().type === "context" && ...}>` block
- Same wrapping pattern as review tab: `GroupIdProvider` + `DirectoryScope` + `TabContext`

**Modified: `src/claxedo-ui/context/claxedo-layout/tab-actions.ts`**
- Add `addContext(dir, sessionId, title)` method

**Modified: `src/claxedo-ui/ClaxedoLayout.tsx`**
- Add context button to `topBarRight`
- Same session-discovery logic as review: find active session tab → create context tab

**Modified: `src/claxedo-ui/layouts/top-tab-bar.tsx`**
- Add `context: "monitor"` to `TAB_ICONS`

---

## Feature 4: Session Page Simplification

### What gets removed from `src/overrides/pages/session.tsx` (~800 lines)

| Category | Lines removed | Details |
|----------|--------------|---------|
| Width calculations | ~40 | `desktopReviewOpen`, `desktopFileTreeOpen`, `desktopSidePanelOpen`, `sessionPanelWidth`, `isCompact`, `messagesHidden`, `centered` |
| Compact mode | ~20 | Auto-toggle effect, auto-restore effect |
| Review integration | ~200 | `reviewPanel()`, `reviewContent()`, `openReviewPanel()`, `focusReviewDiff()`, scroll-to-diff logic, tree store |
| File tree state | ~100 | `fileTreeTab`, `setFileTreeTab`, tree listing effects, changes/all tab sync |
| Side panel tabs | ~150 | `contextOpen`, `openedTabs`, `activeTab`, `activeFileTab`, file tab DnD, `openTab()` |
| JSX | ~150 | `SessionSidePanel` block, `ResizeHandle`, `CompactPromptDock`, width styling |
| Unused imports | ~20 | `SessionSidePanel`, `CompactPromptDock`, DnD, `FileTree`, `Select`, `FileTabContent`, etc. |

### What remains (~1000 lines)
```tsx
return (
  <div class="size-full flex flex-col">
    <SessionHeader />
    <div class="flex-1 min-h-0 flex flex-col">
      {/* Full-width session content */}
      <div class="@container relative flex-1 flex flex-col min-h-0 bg-background-stronger pt-2 md:pt-3">
        <MessageTimeline centered={isDesktop()} ... />
        <SessionPromptDock centered={isDesktop()} ... />
      </div>
    </div>
    <TerminalPanel ... />
  </div>
)
```

### File deletion
- **Delete: `src/overrides/pages/session/session-side-panel.tsx`** — no longer used

---

## State & Persistence

### GroupLayoutState changes
```ts
// Before
type GroupLayoutState = {
  fileTree: { opened: boolean; width: number; tab: "changes" | "all" }
  session: { width: number; collapsed: boolean; panelMode: number }
  reviewPanel: { opened: boolean }
}

// After
type GroupLayoutState = {
  fileTree: { opened: boolean; width: number }
  // session.width, session.panelMode — no longer needed (session is full-width)
  // reviewPanel.opened — no longer needed (review is a tab)
}
```

### TabItem extension
```ts
type TabItem = {
  // ... existing ...
  reviewMode?: "session-turn" | "session" | "uncommitted" | "vs-base" | "to-from"
  reviewFromRef?: string
  reviewToRef?: string
}
```

### Migration
- Update `migrate()` in `claxedo-layout.tsx` to strip `fileTree.tab` from old state
- Old `reviewPanel` / `session` state persists harmlessly (ignored by new UI)
- Bump persist key to `claxedo.layout.v3` with legacy key `["claxedo.layout.v2"]`

### GroupLayoutProvider update
- `fileTree.tab` → always returns `"all"` (no-op setter) for upstream compat
- `reviewPanel` override → keep for upstream compat, becomes inert
- `session` width override → can be simplified/removed

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `context/claxedo-layout/types.ts` | Modify | Add "context" to TabType, add reviewMode fields, simplify GroupLayoutState |
| `context/claxedo-layout/tab-actions.ts` | Modify | Add `addContext()` method |
| `layouts/top-tab-bar.tsx` | Modify | Add context icon |
| `components/file-tree-sidebar.tsx` | **Create** | File tree sidebar component |
| `components/tab-context.tsx` | **Create** | Context tab component |
| `components/tab-review.tsx` | Modify | Add diffMode support, compact dock, git diff modes |
| `layouts/rail-layout.tsx` | Modify | Add FileTreeSidebar to GroupPanel |
| `ClaxedoLayout.tsx` | Modify | Review dropdown, context button, rewire topBarRight |
| `components/group-content-renderer.tsx` | Modify | Add context tab Match case |
| `components/group-layout-provider.tsx` | Modify | Simplify overrides |
| `context/claxedo-layout.tsx` | Modify | Migration update |
| `overrides/pages/session.tsx` | Modify | Remove ~800 lines |
| `overrides/pages/session/session-side-panel.tsx` | **Delete** | No longer used |

---

## Verification Checklist

- [ ] File tree sidebar: toggle button opens/closes sidebar on right side of content
- [ ] File tree sidebar: clicking a file opens a "file" tab
- [ ] File tree sidebar: resizable, width persists
- [ ] File tree sidebar: per-group (each split panel has its own)
- [ ] Review dropdown: shows diff mode options
- [ ] Review tab (session/session-turn): shows session diffs + compact dock for current session
- [ ] Review tab (uncommitted/vs-base/to-from): shows git diffs + compact dock backed by new session
- [ ] Context tab: shows token usage, metrics, raw messages
- [ ] Session page: full-width messages + prompt dock, no side panel
- [ ] Persistence: file tree state survives reload, old state migrates cleanly
- [ ] Split view: each group has independent sidebar and review/context tabs
- [ ] Tests: `bun run test` passes
