import { describe, expect, test } from "bun:test"
import {
  defaultSettingsWorkspace,
  resolveSettingsWorkspace,
  settingsWorkspaceOptions,
  type CatalogProject,
} from "./settings-scope-options"

const catalog: CatalogProject[] = [
  {
    id: "proj_local",
    name: "acme/app",
    worktree: "/repo",
    workspaces: {
      "/repo": { workspaceId: "ws_local", kind: "local", workspace_name: "main", directory: "/repo" },
    },
  },
  {
    id: "proj_cloud",
    name: "acme/api",
    worktree: "workspace:ws_cloud",
    workspaces: {
      "workspace:ws_cloud": { workspaceId: "ws_cloud", kind: "cloud", workspace_name: "sandbox", directory: "/workspace" },
    },
  },
  { id: "proj_bare", name: "proj_bare", worktree: "/other" },
]

describe("settingsWorkspaceOptions", () => {
  test("one row per catalog workspace, addressed by the scope a pane would use", () => {
    expect(settingsWorkspaceOptions(catalog).map((option) => ({
      key: option.key,
      scope: option.scope,
      kind: option.kind,
      label: option.label,
      project: option.project,
    }))).toEqual([
      { key: "ws_local", scope: "workspace:ws_local", kind: "local", label: "main", project: "acme/app" },
      { key: "ws_cloud", scope: "workspace:ws_cloud", kind: "cloud", label: "sandbox", project: "acme/api" },
      { key: "/other", scope: "/other", kind: "local", label: "/other", project: "/other" },
    ])
  })

  test("a workspace with no id is addressed by its directory, the same string a pane resolves", () => {
    expect(settingsWorkspaceOptions([{
      id: "proj",
      name: "proj",
      worktree: "/repo",
      workspaces: { "/repo": { kind: "local", directory: "/repo" } },
    }])).toEqual([{
      key: "/repo",
      scope: "/repo",
      kind: "local",
      label: "/repo",
      project: "/repo",
      directory: "/repo",
    }])
  })
})

describe("defaultSettingsWorkspace", () => {
  const options = settingsWorkspaceOptions(catalog)

  test("the focused workspace wins when the dialog opened over one", () => {
    expect(defaultSettingsWorkspace(options, { workspaceId: "ws_cloud" })?.key).toBe("ws_cloud")
    expect(defaultSettingsWorkspace(options, { directory: "/other" })?.key).toBe("/other")
  })

  test("without a focus, a local workspace is chosen before anything remote", () => {
    const cloudFirst = settingsWorkspaceOptions([catalog[1]!, catalog[0]!])
    expect(cloudFirst[0]!.key).toBe("ws_cloud")
    expect(defaultSettingsWorkspace(cloudFirst)?.key).toBe("ws_local")
  })

  test("with no local workspace, the first catalog row is chosen", () => {
    const remote = settingsWorkspaceOptions([catalog[1]!])
    expect(defaultSettingsWorkspace(remote)?.key).toBe("ws_cloud")
  })

  test("an empty catalog names no workspace at all", () => {
    expect(defaultSettingsWorkspace([])).toBeUndefined()
  })
})

describe("resolveSettingsWorkspace", () => {
  const options = settingsWorkspaceOptions(catalog)

  test("an explicit selection is kept", () => {
    expect(resolveSettingsWorkspace({ options, selected: "ws_cloud" })?.key).toBe("ws_cloud")
  })

  test("a selection the catalog no longer carries falls back to a present row, never to nothing", () => {
    expect(resolveSettingsWorkspace({ options, selected: "ws_gone" })?.key).toBe("ws_local")
  })
})
