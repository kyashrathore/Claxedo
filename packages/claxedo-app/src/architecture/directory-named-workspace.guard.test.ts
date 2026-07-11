import { describe, expect, test } from "bun:test"
import path from "node:path"
import { directoryNamedWorkspaceOffenders, scanForDirectoryNamedWorkspace } from "./directory-named-workspace"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("directory-named-workspace guard (WP-D5)", () => {
  test("flags a reintroduced conflation name, ignores the honest directory name", () => {
    expect(
      scanForDirectoryNamedWorkspace([
        { path: "shell/app-shell-state.ts", text: `const activeWorkspaceId = createMemo(...)` },
        { path: "shell/ok.ts", text: `const activeDirectory = createMemo(...)` },
        { path: "shell/id.ts", text: `snapshot.workspaceId // sanctioned sense-2 keeps the name` },
      ]),
    ).toEqual(["shell/app-shell-state.ts"])
  })

  test("no production or test file uses a retired directory-named-workspace identifier", () => {
    const offenders = directoryNamedWorkspaceOffenders(appRoot).map(
      (file) =>
        `${file}: reintroduces a retired WP-D5 conflation name -- a directory path must not be named ` +
        `workspaceId; use activeDirectory / routeDirectory / resolveActiveDirectory / shellRouteDirectory ` +
        `(see src/VOCABULARY.md sense 1 and src/shell/identity/brand.ts)`,
    )

    expect(offenders).toEqual([])
  })
})
