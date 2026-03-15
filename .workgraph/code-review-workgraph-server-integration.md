# Code Review: WorkGraph Server Integration

**Reviewer:** node_01KKN75NGM067RVCREJRXTMEC6  
**Files Reviewed:**

- `packages/claxedo-app/src/opencode-patches/server/server.ts` (diff: +23 lines)
- `packages/claxedo-app/src/opencode-patches/server/workgraph-execution.ts` (new file)

---

## 1. Top-level Database Initialization (server.ts:73-75)

**Finding:** The `Database` instantiation and `initWorkGraphDb()` run at module import time inside the `Server` namespace.

```typescript
export namespace Server {
  const db = new Database(path.join(Global.Path.data, "workgraph.db"))
  initWorkGraphDb(db)
  const workgraph = createWorkGraphApp(db, { execution: createWorkGraphExecution(db) })
  // ...
}
```

**Risk:** If the data directory doesn't exist, is not writable, or the database file is corrupted, this will throw during import—before the server can start. This is a **blocking failure** at import time.

**Recommendation:** Consider wrapping in try/catch or deferring initialization to `listen()` time. However, if startup must fail fast when the DB is unavailable, current behavior is acceptable.

---

## 2. Directory Normalization Block (server.ts:241-253)

**Comparison with `fixDir()` in api.ts:**

| Aspect                 | `fixDir()` (api.ts:24-36)          | Server normalization                |
| ---------------------- | ---------------------------------- | ----------------------------------- |
| Empty/undefined input  | Returns `undefined`                | No explicit handling                |
| Already absolute (`/`) | Early return                       | No early return                     |
| Prefix matching        | ✅ Same                            | ✅ Same                             |
| No prefix match        | Adds `/` prefix                    | ✅ Same                             |
| Trailing slashes       | Handled by separate `normalized()` | ❌ Not handled                      |
| Windows paths          | ❌ Not handled                     | ✅ Added: `/^[A-Za-z]:[\\/]/` check |

**Issues Found:**

1. **Missing early return for absolute paths:** Unlike `fixDir()`, server code doesn't return early if `directory` already starts with `/`. This could cause incorrect slicing if a path contains `/Users/` as a substring.
2. **Inconsistent with api.ts:** Should match `fixDir()` behavior more closely.
3. **Missing encoded path handling:** Server code has `decodeURIComponent()` but doesn't re-normalize after decoding.

**Recommendation:** Align server normalization with `fixDir()` or extract to shared utility.

---

## 3. Variable Rename `path` → `pathname` (server.ts:256)

**Verification:** The rename from `path` to `pathname` to avoid shadowing `import path from "node:path"` is correct.

- Line 256: `const pathname = c.req.path` ✅
- Line 258: Uses `pathname` in conditionals ✅
- Line 609: Uses `path` (from `c.req.path`) — different context, no conflict ✅

**No issues found.**

---

## 4. `wait()` Helper Listener Cleanup (workgraph-execution.ts:19-49)

**Code:**

```typescript
function wait(dir: string, boot: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error(`Worktree bootstrap timed out for ${dir}`))
    }, 30_000)

    const done = (fn: () => void) => {
      clearTimeout(timeout)
      GlobalBus.off("event", on)
      fn()
    }
    // ...
  })
}
```

**Finding:** ✅ **Correct.** The cleanup is properly handled:

- `clearTimeout(timeout)` on both resolve and reject paths
- `GlobalBus.off("event", on)` removes the listener

**No issues found.**

---

## 5. Fire-and-Forget `void Instance.provide()` (workgraph-execution.ts:74-86)

**Code:**

```typescript
void Instance.provide({
  directory: info.directory,
  init: InstanceBootstrap,
  fn: async () => {
    await SessionPrompt.prompt({
      sessionID: session.id,
      model,
      parts: [{ type: "text", text: input.prompt }],
    })
  },
}).catch((err) => {
  console.error("[workgraph] failed to prompt session", err)
})
```

**Analysis:**

- **Fire-and-forget is acceptable** for session prompting — the session will exist regardless, and prompt failure shouldn't block the execution flow.
- **Error handling present:** The `.catch()` logs the error but doesn't propagate. This is appropriate—prompt failures shouldn't crash the workflow.
- **Potential issue:** If `Instance.provide()` throws synchronously before returning a promise, the error won't be caught.

**Minor Recommendation:** Consider wrapping the entire call in try/catch to handle synchronous throws, but current behavior is acceptable.

---

## 6. Database Query for Attempt Lookup (workgraph-execution.ts:51-57)

**Code:**

```typescript
function open(db: any, runId: string, nodeId: string, sessionId: string) {
  return db
    .query(
      "SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND session_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(runId, nodeId, sessionId) as { attempt_id: string } | null
}
```

**Analysis:**

1. **SQL Correctness:** ✅ Query appears syntactically correct with proper parameterized placeholders.

2. **Runtime Error Risk:** ⚠️ If `initWorkGraphDb(db)` hasn't run (e.g., import-time failure or race condition), the table `attempts_current` won't exist. `db.query(...).get(...)` will throw:

   ```
   SQLITE_ERROR: no such table: attempts_current
   ```

3. **Caller Handling:** The function is called at line 91:
   ```typescript
   if (!open(db, input.run_id, input.node_id, session.id)) {
   ```
   If `open()` throws, this will crash the `stop()` function.

**Recommendation:** Wrap `open()` call in try/catch to handle missing table gracefully, or ensure `initWorkGraphDb()` is called before any execution happens. Consider returning `null` on error rather than throwing.

---

## Summary

| #   | Issue                                            | Severity | Status            |
| --- | ------------------------------------------------ | -------- | ----------------- |
| 1   | Top-level DB init can block/fail at import       | Medium   | Acceptable design |
| 2   | Directory normalization diverges from `fixDir()` | Low      | Needs alignment   |
| 3   | Variable rename verification                     | —        | ✅ No issues      |
| 4   | Listener cleanup in `wait()`                     | —        | ✅ No issues      |
| 5   | Fire-and-forget session prompt                   | Low      | Acceptable        |
| 6   | Missing try/catch on DB query                    | Medium   | Needs fix         |

**Recommendation:** Items 2 and 6 should be addressed before merging. The other items are acceptable as-is or are minor improvements.
