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
  // The key is the model document's workspace half: a workspace the attached
  // server holds is its directory even when the inventory gives it an id,
  // because that is what a pane on that directory keys its model store by.
  test("one row per catalog workspace, keyed the way a pane's model store keys it", () => {
    expect(settingsWorkspaceOptions(catalog).map((option) => ({
      key: option.key,
      scope: option.scope,
      host: option.host,
      label: option.label,
      project: option.project,
    }))).toEqual([
      { key: "/repo", scope: "workspace:ws_local", host: "self", label: "main", project: "acme/app" },
      { key: "ws_cloud", scope: "workspace:ws_cloud", host: "provisioner", label: "sandbox", project: "acme/api" },
      { key: "/other", scope: "/other", host: "self", label: "/other", project: "/other" },
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
      host: "self",
      label: "/repo",
      project: "/repo",
      directory: "/repo",
    }])
  })

  test("a machine's workspace is placed on that machine and keyed by its id", () => {
    expect(settingsWorkspaceOptions([{
      id: "proj",
      name: "proj",
      worktree: "workspace:ws_remote",
      workspaces: { "workspace:ws_remote": { workspaceId: "ws_remote", kind: "user-hosted", directory: "/on/their/mac" } },
    }])[0]).toMatchObject({ key: "ws_remote", host: "machine" })
  })

  // The catalog writes the control plane's word. A row carrying an app host
  // kind instead is a producer this build does not have, so it is placed on the
  // attached server rather than keyed by an id no pane would reach it under.
  test("a row whose kind is not a word the catalog writes is placed on the attached server", () => {
    expect(settingsWorkspaceOptions([{
      id: "proj",
      name: "proj",
      worktree: "/repo",
      workspaces: { "/repo": { workspaceId: "ws_x", kind: "self", directory: "/repo" } },
    }])[0]).toMatchObject({ key: "/repo", host: "self" })
  })
})

describe("defaultSettingsWorkspace", () => {
  const options = settingsWorkspaceOptions(catalog)

  test("the focused workspace wins when the dialog opened over one", () => {
    expect(defaultSettingsWorkspace(options, { workspaceId: "ws_cloud" })?.key).toBe("ws_cloud")
    expect(defaultSettingsWorkspace(options, { directory: "/other" })?.key).toBe("/other")
  })

  test("without a focus, a workspace the attached server holds is chosen before anything remote", () => {
    const cloudFirst = settingsWorkspaceOptions([catalog[1], catalog[0]])
    expect(cloudFirst[0].key).toBe("ws_cloud")
    expect(defaultSettingsWorkspace(cloudFirst)?.key).toBe("/repo")
  })

  test("with nothing on the attached server, the first catalog row is chosen", () => {
    const remote = settingsWorkspaceOptions([catalog[1]])
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
    expect(resolveSettingsWorkspace({ options, selected: "ws_gone" })?.key).toBe("/repo")
  })
})
