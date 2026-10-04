import { afterEach, describe, expect, test } from "vitest"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"
import { hostedWorkspaceSandboxInput } from "./hosted-workspace-sandbox-input"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

type Row = { id: string; repoUrl?: string; branch?: string; directory?: string; region?: string; deletedAt?: number }

async function sandboxInput(rows: Row[]) {
  const instance = await miniflareControlPlaneDatabase()
  active.push(instance)
  const db = instance.database
  await db.batch([
    db.prepare("insert into users values ('owner', 'active', 1, 1, null, null)"),
    db.prepare("insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at, deleted_at) values ('org', 'Org', 'deployment', 'owner', 'deployment-1', 1, 1, null)"),
    db.prepare("insert into projects values ('project', 'org', 'repo:one', 'owner', 1, 1, null)"),
    ...rows.map((row) => db.prepare(`insert into workspaces
      (workspace_id, org_id, project_id, owner_user_id, backing, display_name, home_region, repo_url, git_branch, remote_directory, created_at, updated_at, deleted_at)
      values (?, 'org', 'project', 'owner', 'cloud-vm', ?, ?, ?, ?, ?, 1, 1, ?)`)
      .bind(row.id, row.id, row.region ?? null, row.repoUrl ?? null, row.branch ?? null, row.directory ?? null, row.deletedAt ?? null)),
  ])
  return hostedWorkspaceSandboxInput({
    database: db,
    egress: {
      relayUrls: { "us-east": "https://relay-us.test", "eu-west": "https://relay-eu.test" },
      sandboxEgressExtraHosts: ["git.internal.test"],
      sandboxControlPlaneOrigin: "https://core.test",
    },
  })
}

const secrets = [{ name: "ANTHROPIC_API_KEY", value: "sk-ant", hosts: ["api.anthropic.com"] }]

describe("a hosted workspace's sandbox input rebuilt from its D1 row", () => {
  test("carries the row's region, project, source, root and egress with the preparation's env and secrets", async () => {
    const build = await sandboxInput([{ id: "ws_1", repoUrl: "https://gitlab.com/acme/app.git", branch: "dev", directory: "/srv/app", region: "eu-west" }])
    const input = await build("ws_1", { preparation: { secrets, env: { A: "1" } }, secrets: [] })
    expect(input).toMatchObject({
      homeRegion: "eu-west",
      labels: { projectId: "project" },
      workspaceRoot: "/srv/app",
      source: { kind: "git", repoUrl: "https://gitlab.com/acme/app.git", branch: "dev" },
      env: { A: "1" },
      secrets,
      net: { mode: "restricted", hosts: expect.arrayContaining(["relay-eu.test", "core.test", "gitlab.com", "git.internal.test"]) },
    })
    expect(input.net?.hosts).not.toContain("relay-us.test")
  })

  test("a row with no remote or directory gets an empty source and the default root", async () => {
    const input = await (await sandboxInput([{ id: "ws_1" }]))("ws_1", { preparation: undefined, secrets: [] })
    expect(input).toMatchObject({ homeRegion: "us-east", workspaceRoot: "/workspace", source: { kind: "empty" }, secrets: [] })
    expect(input.net?.hosts).not.toContain("github.com")
  })

  test("a workspace with no live row, missing or deleted, is refused", async () => {
    const build = await sandboxInput([{ id: "ws_deleted", repoUrl: "https://gitlab.com/acme/app.git", deletedAt: 5 }])
    for (const workspaceId of ["ws_missing", "ws_deleted"]) {
      await expect(build(workspaceId, { preparation: undefined, secrets: [] })).rejects.toThrow(`workspace ${workspaceId} has no live workspace row`)
    }
  })
})
