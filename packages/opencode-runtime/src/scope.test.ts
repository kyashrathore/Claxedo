import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { assertLocationInScope, authorizeWorkspace, sameScope, WorkspaceScopeError } from "./scope"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-scope-"))
}

test("requires a canonical workspace id", () => {
  expect(() => authorizeWorkspace({ workspaceID: "  ", directory: tempDir() })).toThrow(WorkspaceScopeError)
})

test("requires an absolute directory", () => {
  expect(() => authorizeWorkspace({ workspaceID: "w", directory: "./relative" })).toThrow(/absolute/)
})

test("rejects a directory that does not exist", () => {
  expect(() => authorizeWorkspace({ workspaceID: "w", directory: "/nope/does/not/exist" })).toThrow(WorkspaceScopeError)
})

test("rejects a path that is not a directory", () => {
  const root = tempDir()
  const file = path.join(root, "a-file")
  fs.writeFileSync(file, "x")
  expect(() => authorizeWorkspace({ workspaceID: "w", directory: file })).toThrow(/not a directory/)
})

test("resolves symlinks so a later retarget cannot widen access", () => {
  const root = fs.realpathSync(tempDir())
  const real = path.join(root, "real")
  const other = path.join(root, "other")
  const link = path.join(root, "link")
  fs.mkdirSync(real)
  fs.mkdirSync(other)
  fs.symlinkSync(real, link)

  const scope = authorizeWorkspace({ workspaceID: "w", directory: link })
  expect(scope.directory).toBe(real)

  // Retarget the symlink; a record at the NEW target must not pass the old scope.
  fs.unlinkSync(link)
  fs.symlinkSync(other, link)
  expect(() => assertLocationInScope(scope, other)).toThrow(WorkspaceScopeError)
  // The originally authorized real path still validates.
  expect(() => assertLocationInScope(scope, real)).not.toThrow()
})

test("refuses to attribute a record with no location", () => {
  const scope = authorizeWorkspace({ workspaceID: "w", directory: tempDir() })
  expect(() => assertLocationInScope(scope, undefined)).toThrow(/no location/)
})

test("sameScope compares identity and resolved path", () => {
  const dir = tempDir()
  const a = authorizeWorkspace({ workspaceID: "w", directory: dir })
  const b = authorizeWorkspace({ workspaceID: "w", directory: dir })
  const c = authorizeWorkspace({ workspaceID: "other", directory: dir })
  expect(sameScope(a, b)).toBe(true)
  expect(sameScope(a, c)).toBe(false)
})
