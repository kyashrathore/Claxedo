/// <reference types="bun" />
import { expect, test } from "bun:test"
import { accountCatalogFromWire } from "./account-catalog"
import { cloudWorkspaceFromRow } from "./cloud"

test("a cloud workspace reads its own name, and one whose stored name is its id reads Cloud workspace with its branch", () => {
  expect(cloudWorkspaceFromRow({ workspace_id: "ws_1", project_id: "prj_1", workspace_name: "payments", git_branch: "main" })?.name).toBe("payments")
  expect(cloudWorkspaceFromRow({ workspace_id: "ws_2", project_id: "prj_1", display_name: "ws_2", git_branch: "dev" })?.name).toBe("Cloud workspace · dev")
  expect(cloudWorkspaceFromRow({ workspace_id: "ws_3", project_id: "prj_1" })?.name).toBe("Cloud workspace")
})

test("the account catalog labels a cloud placement the same way and a machine placement by its folder, never by an id", () => {
  const { placements } = accountCatalogFromWire([
    { workspace_id: "ws_2", project_id: "prj_1", display_name: "ws_2", git_branch: "dev" },
    { workspace_id: "ws_4", project_id: "prj_1", backing: "local-worktree", display_name: "ws_4", remote_directory: "/Users/ada/code/shop" },
  ])
  expect(placements.map((record) => record.placement.label)).toEqual(["Cloud workspace · dev", "shop"])
})
