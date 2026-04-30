# Code Review: Tab Actions and Multi-Pane Updates

## Summary

The changes add WorkGraph page tab support with a shortened "wkg-" route ID prefix and integrate the TabWorkgraph component into the multi-pane leaf node renderer.

## Files Reviewed

### 1. `tab-actions.ts` (5 lines changed)

**Changes:**

- Added `prefix()` helper function to generate shorter tab IDs
  - Returns `"wkg"` for workgraph pages (`type === "page" && pageId === "__workgraph__"`)
  - Returns `tab.type` for all other tab types
- Modified `add()` method to use `prefix(tab)` instead of `tab.type` for ID generation

**Verification:**

- ✅ `addPage(pageId, title, directory?, filePath?)` signature matches `handleOpenWorkGraph` call at `ClaxedoLayout.tsx:503`:
  ```typescript
  tabs.addPage("__workgraph__", "WorkGraph", dir)
  ```
- ✅ Consistent with `createTabActions()` factory pattern - returns `tabActions` object with all tab manipulation methods
- ✅ Simple, composable helper function

### 2. `generic-leaf-node.tsx` (18 lines changed)

**Changes:**

- Import `TabWorkgraph` component (line 29)
- Add title handling for WorkGraph page (line 401):
  ```typescript
  if (content.type === "page" && content.pageId === "__workgraph__") return "WorkGraph"
  ```
- Add new `<Match>` case for `__workgraph__` page type (lines 903-916) - renders `TabWorkgraph` component
- Modify existing page Match to exclude `__workgraph__` (line 917)

**Verification:**

- ✅ SolidJS reactivity correct: `contentTitle` uses `createMemo()` at line 386, properly tracks reactive dependencies
- ✅ No new props added to component interface - this is a render change adding content type handling
- ✅ Call sites already pass all required props - `GenericLeafNode` receives `content: Accessor<PaneContent | undefined>` which already contains the necessary data

### 3. `claxedo-layout.test.ts` (13 new lines)

**Changes:**

- Added test "workgraph page tab uses a wkg route id" (lines 1724-1735)

**Test Code:**

```typescript
test("workgraph page tab uses a wkg route id", () => {
  const { api, dispose } = createTestLayout()
  try {
    const { tabs1 } = splitInto2(api)
    const id = tabs1.addPage("__workgraph__", "WorkGraph", "/ws")

    expect(id).toMatch(/^wkg-/)
    expect(tabs1.items().find((t: any) => t.id === id)?.pageId).toBe("__workgraph__")
  } finally {
    dispose()
  }
})
```

**Verification:**

- ✅ Uses correct SolidJS test patterns: `createTestLayout()` wraps `createRoot` for reactive tracking
- ✅ Follows existing test structure: gets `api` from `initLayout()`, uses `splitInto2()` helper
- ✅ No bare `createMemo` for store props - tests call actual tab action methods
- ✅ Covers the tab-actions change: verifies the "wkg-" prefix is generated correctly

## Test Results

- 1979 tests pass
- 2 unrelated failures (persisted storage, process-pane - pre-existing)
- The workgraph-specific test runs successfully

## Review Decision

**APPROVED** - Changes are correct and follow existing patterns.

### Key Decisions:

1. Shortened "wkg-" prefix chosen over "page-" to avoid potential ID collisions with other page types
2. WorkGraph handled as special page type rather than new tab type, maintaining consistency with existing page tabs (**index**, etc.)
3. TabWorkgraph integrated into existing Switch/Match pattern for content type rendering
