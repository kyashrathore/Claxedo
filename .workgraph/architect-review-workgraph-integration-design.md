# WorkGraph Integration Architecture Review

## Executive Summary

The WorkGraph integration is well-architected overall with proper separation of concerns between the `@opencode-ai/workgraph` package and claxedo-app. However, there are several issues that need attention before production readiness.

---

## 1. ExecutionAdapter Worktree Isolation ✅ CORRECT

**Finding**: The implementation correctly integrates worktree isolation for non-shared kinds.

**Analysis** (`workgraph-execution.ts:15-17, 62-68`):

```typescript
function shared(kind: string) {
  return ["research", "docs", "design", "review"].includes(kind)
}
```

- The `shared()` function correctly identifies kinds that should share the parent workspace
- Non-shared kinds (`task`, `verification_task`, `synthesis_task`) get isolated worktrees
- The `launch()` function creates worktrees via `Worktree.makeWorktreeInfo()` and `Worktree.createFromInfo()` for isolated kinds
- The cleanup function properly handles both "archive" and "delete" modes

**Verdict**: ✅ Correctly implemented

---

## 2. DB Path Collision Risk ⚠️ CONCERN

**Finding**: The DB path uses a global path that could collide across workspaces.

**Analysis** (`server.ts:73`):

```typescript
const db = new Database(path.join(Global.Path.data, "workgraph.db"))
```

- `Global.Path.data` is a single global path for the entire OpenCode server
- All workspaces share the same `workgraph.db` file
- This means:
  - Run IDs must be globally unique (they use ULIDs, so this is fine)
  - Multiple concurrent runs across different workspaces share the same database
  - In a shared-server/multi-tenant scenario, this could be problematic

**Potential Issues**:

- No workspace-scoped database isolation
- If `Global.Path.data` points to a shared location, runs from different users could interfere

**Recommendation**: Consider accepting a `DB_PATH` override via environment variable, or scoping the DB path to the workspace directory for true isolation.

**Verdict**: ⚠️ Acceptable for single-user desktop scenarios, but a concern for multi-tenant deployments

---

## 3. Module-Init Lifecycle Risks ⚠️ CONCERN

**Finding**: Top-level initialization in the Server namespace has potential lifecycle issues.

**Analysis** (`server.ts:73-75`):

```typescript
export namespace Server {
  const db = new Database(path.join(Global.Path.data, "workgraph.db"))
  initWorkGraphDb(db)
  const workgraph = createWorkGraphApp(db, { execution: createWorkGraphExecution(db) })
```

**Issues**:

1. **Startup blocking**: Database creation and schema initialization run at import time, not when the server is ready to accept requests
2. **Error propagation**: If the database path is not writable or the schema initialization fails, the entire server module fails to load
3. **No lazy initialization**: Unlike the `app` which uses `lazy()`, the workgraph app is eagerly initialized

**Recommendation**: Consider lazy initialization pattern similar to how `App` is handled:

```typescript
const workgraph = lazy(() => createWorkGraphApp(db, { execution: createWorkGraphExecution(db) }))
```

**Verdict**: ⚠️ Functional but not ideal for robust error handling

---

## 4. MCP Mode "both" ✅ CORRECT WITH CAVEATS

**Finding**: The `mode: "both"` registration is appropriate but worth documenting.

**Analysis** (`claxedo-mcp.ts:354-358`):

```typescript
registerWorkGraphTools(server, httpRequest, {
  origin: `${ORIGIN}/api/workgraph`,
  directory: DEFAULT_DIR,
  mode: "both",
})
```

**Assessment**:

- **Agent-only tools**: `create_node`, `add_edge`, `remove_edge`, `validate_graph`, `finish_planning`, `update_status`, `write_scratchpad`, `create_artifact` — these are primarily used by agents during planning/execution
- **User-facing tools**: `get_graph`, `get_run_status`, `read_scratchpads` — useful for UI display
- **Hybrid tools**: Most tools make sense in both contexts

The `mode: "both"` is actually correct because:

1. The MCP tools are scoped by `run_id` (and optionally `node_id`) per the SPEC.md
2. Unauthorized access is prevented by the scoping mechanism
3. Both agents and UI need access to read operations

**Verdict**: ✅ Correct

---

## 5. Missing Error Boundaries ⚠️ ISSUES FOUND

**Finding**: Several areas lack proper error handling.

### 5.1 Unhandled Promise Rejections in `launch()` ❌

**Location**: `workgraph-execution.ts:61-141`

The `launch()` function is async but:

- No try-catch wrapper around the main logic
- If `Worktree.makeWorktreeInfo()` or `Worktree.createFromInfo()` throws, the promise rejects unhandled
- If `Session.create()` fails, the rejection is unhandled

**Example issue**:

```typescript
// Line 66-67: If this throws, no error handling
const boot = await Worktree.createFromInfo(info)
await wait(info.directory, boot)
```

### 5.2 Database Query Error Handling ❌

**Location**: `workgraph-execution.ts:51-57`

```typescript
function open(db: any, runId: string, nodeId: string, sessionId: string) {
  return db
    .query(...)
    .get(runId, nodeId, sessionId) // Could throw if table doesn't exist
}
```

If `initWorkGraphDb()` hasn't run (due to lifecycle issues in #3), this will throw.

### 5.3 Event Listener Leaks — ✅ CLEAN

**Location**: `workgraph-execution.ts:19-49`

The `wait()` function correctly cleans up event listeners in both resolve and reject paths.

### 5.4 Fire-and-Forget Prompt — ✅ ACCEPTABLE

**Location**: `workgraph-execution.ts:74-86`

```typescript
void Instance.provide({
  ...
}).catch((err) => {
  console.error("[workgraph] failed to prompt session", err)
})
```

This is appropriate — session prompting failures shouldn't block execution.

**Recommendation**: Add try-catch to the `launch()` function:

```typescript
async launch(input) {
  try {
    // ... existing logic
  } catch (err) {
    console.error("[workgraph] launch failed", err)
    throw err
  }
}
```

**Verdict**: ⚠️ Partial coverage — need error boundaries in launch function

---

## Additional Observations

### A. Frontend API Client Quality ✅

The `workgraph-api.ts` is well-designed:

- Uses `authFetch` for authentication
- Has proper error handling for HTML responses (fallback logic)
- Comprehensive type coverage
- Good fallback defaults in `detail()` function

### B. SPEC.md Conformance ✅

The implementation follows the SPEC.md well:

- MCP tool scoping per `run_id` is implemented
- Event sourcing model is in place
- DAG engine with typed edges is implemented
- Session backend is the primary execution backend

### C. Security Considerations

- MCP tools are properly scoped
- Database queries use parameterized statements (no SQL injection)
- No exposed secrets in the code

---

## Summary Table

| Area               | Status     | Notes                                                  |
| ------------------ | ---------- | ------------------------------------------------------ |
| Worktree Isolation | ✅ Correct | Properly implemented for non-shared kinds              |
| DB Path            | ⚠️ Concern | Global path OK for single-user, issue for multi-tenant |
| Module Lifecycle   | ⚠️ Concern | Works but not lazy-initialized                         |
| MCP Mode           | ✅ Correct | "both" is appropriate                                  |
| Error Handling     | ⚠️ Issues  | Missing try-catch in launch(), potential DB errors     |

---

## Recommendations

### High Priority

1. **Add error boundary** to `launch()` function in `workgraph-execution.ts`
2. **Add try-catch** around worktree creation in `launch()`

### Medium Priority

3. **Consider lazy initialization** for workgraph app (like `App` pattern)
4. **Document DB path** limitation for multi-tenant scenarios

### Low Priority

5. Add integration tests for error scenarios
6. Consider workspace-scoped DB paths as a future enhancement

---

## Conclusion

The WorkGraph integration is **mostly production-ready** with the main concerns being error handling in the execution adapter. The architecture follows the SPEC.md correctly, and the integration points between packages are well-designed.

**Recommendation**: Address the error boundary issues before merging. The other concerns are acceptable tradeoffs for the current implementation scope.
