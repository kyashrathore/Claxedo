import { expect, test } from "bun:test"
import { cloudWorkspaceFromRow } from "./cloud"

const row = { workspace_id: "ws_1", project_id: "prj_1", workspace_name: "Payments", backing: "cloud-vm" }

test("cloud rows: every lifecycle status the hosted inventory sends maps to its workspace status", () => {
  const cases = [
    [{ status: "ready", reachable: true }, { kind: "ready" }],
    [{ status: "provisioning", reachable: false }, { kind: "provisioning", step: "provisioning" }],
    [{ status: "stopped", reachable: false }, { kind: "stopped" }],
    [{ status: "failed", error: "provider_rejected", reachable: false }, { kind: "failed", reason: "provider_rejected" }],
  ] as const
  for (const [lifecycle, status] of cases) expect(cloudWorkspaceFromRow({ ...row, ...lifecycle })?.status).toEqual(status)
})

test("cloud rows: a row without a status is a contract failure the row shows", () => {
  expect(cloudWorkspaceFromRow(row)?.status).toEqual({ kind: "failed", reason: "The cloud workspace reports an unknown status: undefined" })
})

test("cloud rows: a workspace a machine serves is not a cloud workspace", () => {
  expect(cloudWorkspaceFromRow({ ...row, backing: "local-worktree" })).toBeUndefined()
})
