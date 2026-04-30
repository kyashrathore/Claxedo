# Sidebar Sub-Groups: Processes Under Workspace

## Goal

Extend the rail sidebar so that each workspace section can show a **Processes** sub-group beneath the session list. Sessions stay at the root level with their existing pagination. The new sub-group is only for process tabs for now, but the structure should stay easy to extend later if we decide to add terminals, files, or other tab types.

---

## Current Architecture

```
RailSidebar
└── For each section (workspace):
    ├── Section Header (project label + cloud/local icon + actions)
    └── Session rows (flat list)
        ├── SessionRow × N
        ├── "No sessions yet" (empty state)
        └── "Load more" (pagination)
```

Sessions come from `globalSync.globalSessions.store.byWorkspace[dir]` (server-backed, paginated).
Process tabs come from the active split layout via `claxedo.split.groups()` and `claxedo.groupTabs(group.id)` (client-side, in-memory).

The sidebar currently shows only sessions.

---

## Target Architecture

```
RailSidebar
└── For each section (workspace):
    ├── Section Header (project label + cloud/local icon + actions)
    ├── Session rows (root level, unchanged)
    │   ├── SessionRow × N
    │   ├── "No sessions yet" (only when the section has no sessions and no process rows)
    │   └── "Load more" (server-backed pagination)
    │
    └── PROCESSES (only rendered when items exist)
        ├── ▶ dev server
        ├── ▶ api watcher
        └── "Show more" (client-side pagination)
```

Key principles:
- Sessions stay at root.
- Only process tabs are shown as a subgroup in the first version.
- The section empty state is holistic: if sessions are empty but process rows exist, do not render `"No sessions yet."`
- Process rows use client-side pagination.
- Clicking a process row activates the tab in its owning group and focuses that split panel.
- The implementation should stay easy to extend to more subgroup types later, but those are not in scope for the first pass.

---

## Data Model Changes

### 1. Extend `View` type

Keep the new view field narrow and process-specific for now:

```ts
type Group = "workspace" | "updated" | "status" | "environment"
type Archive = "active" | "all" | "archived"
type ProcessMode = "show" | "hide"

type View = {
  group: Group
  processes: ProcessMode
  status: string[]
  environment: string[]
  git: string[]
  archived: Archive
}
```

Default: `processes: "show"`.

`loadView()` / `saveView()` should persist this under the existing `VIEW_KEY`.

### 2. No store changes

This is a view concern. The existing tab state already gives us what we need.

---

## Process Definition

For now there is exactly one subgroup:

```ts
const PROCESS_GROUP = {
  id: "processes",
  label: "Processes",
  icon: "play",
  type: "process",
} as const
```

This keeps the implementation simple now while leaving room to generalize later.

---

## Implementation Plan

### Step 1: Helper — `processesForDirectory()`

Collect all process tabs for a workspace directory, using the same per-group ordering the tab bar already exposes:

```ts
const processesForDirectory = (dir?: string): TabItem[] => {
  if (!dir) return []
  return claxedo.split.groups().flatMap((group) =>
    claxedo
      .groupTabs(group.id)
      .visualOrderedItems()
      .filter((tab) => tab.directory === dir && tab.type === "process")
  )
}
```

### Step 2: `ProcessSection` component

Render a single labeled process list with its own local pagination:

```tsx
function ProcessSection(props: {
  items: TabItem[]
  onActivate: (tab: TabItem) => void
}) {
  const base = 5
  const [limit, setLimit] = createSignal(base)
  const rows = createMemo(() => props.items.slice(0, limit()))
  const more = createMemo(() => props.items.length > limit())
  const remaining = createMemo(() => props.items.length - limit())

  return (
    <div class="mt-1">
      <div class="flex items-center gap-1.5 px-3.5 py-0.5">
        <Icon name="play" size="small" class="text-icon-weak/40" />
        <span class="text-[10px] uppercase tracking-wider text-text-weak/40 font-medium">
          Processes
        </span>
        <span class="text-[10px] text-text-weak/30">{props.items.length}</span>
      </div>

      <For each={rows()}>
        {(tab) => (
          <button
            type="button"
            class="w-full flex items-center gap-2 py-1 pl-5 pr-2.5 text-left rounded-md
                   hover:bg-surface-base-hover/40 transition-colors duration-100"
            onClick={() => props.onActivate(tab)}
          >
            <Icon name="play" size="small" class="text-icon-weak shrink-0" />
            <span class="text-[13px] text-text-weak truncate flex-1 min-w-0">
              {tab.title || "Process"}
            </span>
            <Show when={tab.attention}>
              <div class="size-1.5 rounded-full bg-icon-critical-base shrink-0" />
            </Show>
          </button>
        )}
      </For>

      <Show when={more()}>
        <button
          type="button"
          class="text-[12px] text-text-weak/40 hover:text-text-weak/70 px-5 py-1 text-left transition-colors duration-100"
          onClick={() => setLimit((n) => n + 5)}
        >
          Show more ({remaining()} more)
        </button>
      </Show>
    </div>
  )
}
```

### Step 3: Integrate into section rendering

Inside the existing `<Show when={open()}>` block, render process rows after session rows:

```tsx
<Show when={open()}>
  <div class="flex flex-col pb-1">
    <For each={section.rows}>
      {(session) => <SessionRow {...session} />}
    </For>

    <Show when={view().processes === "show" && section.workspaceDir}>
      {(dir) => {
        const rows = createMemo(() => processesForDirectory(dir()))

        return (
          <>
            <Show when={section.project && showEmpty(section.rows.length, count(), more()) && rows().length === 0}>
              <div class="px-3.5 py-2">
                <div class="text-[12px] text-text-weak/45">No sessions yet.</div>
              </div>
            </Show>
            <Show when={more()}>
              <button ...>{language.t("common.loadMore")}</button>
            </Show>
            <Show when={rows().length > 0}>
              <ProcessSection
                items={rows()}
                onActivate={(tab) => {
                  const group = claxedo
                    .split
                    .groups()
                    .find((row) => claxedo.groupTabs(row.id).items().some((item) => item.id === tab.id))
                  if (group) {
                    claxedo.groupTabs(group.id).setActive(tab.id)
                    claxedo.split.setFocus(group.id)
                  }
                }}
              />
            </Show>
          </>
        )
      }}
    </Show>
  </div>
</Show>
```

If the session empty state and session `Load more` button stay outside this block, keep the same rule:

- render `"No sessions yet."` only when the section has no session rows and no process rows
- render session `Load more` from the filtered session result, not from hidden rows

### Step 4: Filter menu toggle

Add a process-specific toggle to the existing `FilterMenu`:

```tsx
<DropdownMenu.Separator />

<DropdownMenu.Group>
  <DropdownMenu.GroupLabel>Sidebar items</DropdownMenu.GroupLabel>
  <DropdownMenu.CheckboxItem
    checked={view().processes === "show"}
    onChange={() =>
      setView((prev) => ({
        ...prev,
        processes: prev.processes === "show" ? "hide" : "show",
      }))
    }
    closeOnSelect={false}
  >
    <span class="flex-1">Show processes</span>
  </DropdownMenu.CheckboxItem>
</DropdownMenu.Group>
```

This can be generalized later if more subgroup types are added.

---

## Tab Activation Behavior

When a user clicks a process row:

1. Find the owning group by scanning `claxedo.split.groups()`.
2. Activate the tab with `claxedo.groupTabs(groupId).setActive(tabId)`.
3. Focus the group with `claxedo.split.setFocus(groupId)`.
4. Let the existing sidebar collapse behavior continue unchanged.

---

## Pagination Strategy

| Layer | Source | Strategy |
|-------|--------|----------|
| Sessions | Server (`globalSync.globalSessions`) | Server-backed: `loadMoreWorkspaceSessions()` fetches next page |
| Processes | Client (`claxedo.split.groups()` + `claxedo.groupTabs(group.id)`) | Client-side: `slice(0, limit)` with "Show more" button |

---

## Visual Mockup

### Sidebar with processes enabled

```
┌─────────────────────────────┐
│ myproject / main        💻  │
│   Fix auth bug          2m  │
│   Add test coverage     1h  │
│   Load more                 │
│                             │
│   ▶ PROCESSES (2)           │
│      ▶ dev server           │
│      ▶ api watcher      🔴  │
└─────────────────────────────┘
```

### Sidebar with processes hidden

```
┌─────────────────────────────┐
│ myproject / main        💻  │
│   Fix auth bug          2m  │
│   Add test coverage     1h  │
│   Load more                 │
└─────────────────────────────┘
```

---

## Files to Modify

| File | Change |
|------|--------|
| `layouts/rail-sidebar.tsx` | Extend `View`, add process list rendering, extend `FilterMenu` |
| `layouts/rail-sidebar.logic.ts` | Move pure process helpers here if they need their own tests |
| `layouts/rail-sidebar.logic.vitest.ts` | Add process grouping and empty-state coverage |

No store or provider changes are required.

---

## Migration

Adding `processes` to the persisted `View` is backward-compatible:

```ts
function loadView() {
  return {
    group: /* ... */,
    processes: row.processes === "hide" ? "hide" : "show",
    status: /* ... */,
    environment: /* ... */,
    git: /* ... */,
    archived: /* ... */,
  }
}
```

Older saved views default to showing process rows.

---

## Future Extensions

This first pass should only implement process rows. If we expand later, the next steps can be:

1. Generalize `processesForDirectory()` into a reusable subgroup collector.
2. Replace `ProcessSection` with a generic subgroup component.
3. Add more subgroup definitions for terminals, files, or split panels.
4. Convert the process toggle into a more general sidebar-items control.

Those extensions should happen only after the process-only version feels solid.

---

## Testing

### Manual verification

1. Open a workspace with active process tabs.
2. Verify the process list appears below sessions with the correct count.
3. Verify `Show more` works when there are more than five processes.
4. Click a process row and verify it activates the process tab and focuses the correct split panel.
5. Toggle `Show processes` off and verify the process list disappears.
6. Refresh and verify the setting persists.
7. Verify workspaces with no sessions but with processes do not show `"No sessions yet."`

### Unit tests

- `processesForDirectory()` collects process tabs across multiple groups using the current visible tab ordering.
- empty-state logic hides `"No sessions yet."` when process rows exist.
- process toggle persists through `loadView()` / `saveView()`.
- clicking a process row selects the owning tab and focuses the owning group.
