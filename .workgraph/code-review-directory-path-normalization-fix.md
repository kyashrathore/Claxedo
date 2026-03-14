# Code Review: Directory Path Normalization Fix

## Summary

The `fixDir()` function and its server-side duplicate correctly handle the common case of resolving relative paths from temp/working directories, but there are gaps in path coverage and missing test cases.

---

## 1. Path Roots Coverage

### Finding: Incomplete path root coverage

**Severity: Low**

The function handles these prefixes:

- `/Users/`, `/private/`, `/Volumes/`, `/home/` (with leading slash)
- `Users`, `private`, `Volumes`, `home` (without leading slash)

**Missing roots that may be relevant:**

- `/tmp/` — common temporary directory
- `/var/` — system files
- `/opt/` — optional software

**Already-absolute paths not matching prefixes** (e.g., `/tmp/foo`):
Line 27 correctly returns unchanged: `if (txt.startsWith("/")) return txt`

**Recommendation:** Document that only these 4 path roots are supported. Consider adding `/tmp/` if that's a common case.

---

## 2. Multi-Hit Logic

### Finding: Earliest match is correct for root detection

**Severity: None**

The `.sort((a, b) => a - b)[0]` takes the earliest index, which is correct when looking for the actual path root. For example:

- `tmp/dev/Users/yash/project` → finds `/Users/` at index 8 → returns `/Users/yash/project` ✓

Edge case consideration: If a path contains `/Users/` as a subdirectory name (e.g., `/home/dev/Users-data`), the function would incorrectly treat it as the root. However, this is unlikely in practice and the current behavior is reasonable.

---

## 3. Export and Usage

### Finding: Correct export and application

**Severity: None**

- `fixDir` is exported at line 24 in `api.ts` ✓
- `authFetch` (line 83) applies `fixDir` only to `activeDirectory`:
  ```ts
  const activeDirectory = fixDir((window as any).__OPENCODE__?.activeDirectory as string | undefined)
  ```
- The normalized path is used only in the `x-opencode-directory` header (line 92), not in URL construction ✓

---

## 4. Server-Side vs Client-Side Consistency

### Finding: Inconsistent Windows path guard

**Severity: Medium**

**Server-side** (`server.ts:246`):

```ts
if (!path.isAbsolute(directory) && /^[A-Za-z]:[\\/]/.test(directory) === false) {
```

**Client-side** (`api.ts:27`):

```ts
if (txt.startsWith("/")) return txt
```

The server has a Windows path guard (`/^[A-Za-z]:[\\/]/`) that the client lacks. This means:

- Windows paths like `C:\Users\foo` pass through on client unchanged (line 27 sees no leading `/`, continues)
- On server, Windows paths are detected and kept as-is due to the guard

**Recommendation:** Add the same Windows path guard to `fixDir` in `api.ts`:

```ts
if (txt.startsWith("/")) return txt
if (/^[A-Za-z]:[\\/]/i.test(txt)) return txt // Add Windows guard
```

---

## 5. Test Coverage Gaps

### Finding: Missing edge cases

**Severity: Medium**

**Current tests** (`api.test.ts:33-44`):

- ✓ Absolute path: `/Users/yash/project`
- ✓ Relative with prefix: `Users/yash/project`
- ✓ Embedded: `tmp/dev/Users/yash/project`

**Missing test cases:**

- Empty string: `fixDir("")` → should return `undefined` (line 26)
- Undefined: `fixDir(undefined)` → should return `undefined` (line 26)
- Already-absolute not in list: `fixDir("/tmp/foo")` → returns `/tmp/foo`
- Windows path: `fixDir("C:\\Users\\foo")` → currently not handled
- Path with encoded characters: `fixDir("Users%2Ffoo%2Fproject")` → may need `decodeURIComponent`
- Non-matching relative: `fixDir("other/project")` → returns as-is

**Recommendation:** Add tests for these edge cases to ensure robustness.

---

## Action Items

1. **Add Windows path guard to `fixDir`** in `api.ts` to match server behavior
2. **Expand test coverage** to include: empty string, undefined, `/tmp/` paths, Windows paths, encoded paths
3. **Document supported path roots** in a comment above the function
4. **Consider adding `/tmp/`** to the prefix list if that's a common workspace location

---

## Verdict

**Ready to merge with recommendations.** The core logic is correct for the intended use case. The main issue is the missing Windows path guard, which should be fixed before merging to ensure consistency between client and server behavior.
