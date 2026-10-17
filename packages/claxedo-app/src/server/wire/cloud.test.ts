import { expect, test } from "bun:test"
import { cloudWorkspaceFromRow, codeHostRepositoryListingFromBody } from "./cloud"

test("repository listing: the code host's access parses, keeping only https settings links", () => {
  const installations = [{ account: "kyashrathore", settingsUrl: "https://github.com/settings/installations/7", repositorySelection: "selected" }] as const
  const read = codeHostRepositoryListingFromBody({
    repositories: [{ id: "1", fullName: "kyashrathore/site", private: false }],
    access: { kind: "app", installations: [{ account: "evil", settingsUrl: "javascript:alert(1)", repositorySelection: "all" }, ...installations] },
  })
  expect(read).toEqual({ repositories: [{ id: "1", fullName: "kyashrathore/site", private: false }], access: { kind: "app", installations } })
  expect(codeHostRepositoryListingFromBody({ repositories: [], access: { kind: "token", settingsUrl: "http://github.com/settings" } })).toEqual({ repositories: [] })
  expect(codeHostRepositoryListingFromBody({ repositories: [] })).toEqual({ repositories: [] })
})

const row = { workspace_id: "ws_1", project_id: "prj_1", workspace_name: "Payments", backing: "cloud-vm" }

test("cloud rows: every lifecycle status the hosted inventory sends maps to its workspace status", () => {
  const cases = [
    [{ status: "ready", reachable: true }, { kind: "ready" }],
    [{ status: "provisioning", reachable: false }, { kind: "provisioning", step: "provisioning" }],
    [{ status: "stopped", reachable: false }, { kind: "stopped" }],
    [{ status: "stopped", stopReason: "The workspace's runtime stopped answering; it was stopped after 10 minutes.", reachable: false }, { kind: "stopped", reason: "The workspace's runtime stopped answering; it was stopped after 10 minutes." }],
    [{ status: "failed", error: "provider_rejected", reachable: false }, { kind: "failed", reason: "provider_rejected" }],
    [{ status: "failed", error: "saved files expired", checkpointUnusable: "expired", reachable: false }, { kind: "failed", reason: "saved files expired", checkpointUnusable: true }],
  ] as const
  for (const [lifecycle, status] of cases) expect(cloudWorkspaceFromRow({ ...row, ...lifecycle })?.status).toEqual(status)
})

test("cloud rows: a row without a status is a contract failure the row shows", () => {
  expect(cloudWorkspaceFromRow(row)?.status).toEqual({ kind: "failed", reason: "The cloud workspace reports an unknown status: undefined" })
})

test("cloud rows: a workspace a machine serves is not a cloud workspace", () => {
  expect(cloudWorkspaceFromRow({ ...row, backing: "local-worktree" })).toBeUndefined()
})
