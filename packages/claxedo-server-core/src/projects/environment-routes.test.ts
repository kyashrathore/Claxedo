import { afterAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SignedControlPlaneAuth } from "../platform/auth/auth"
import type { ProjectAction, ProjectRole, WorkspaceAuthority } from "../platform/auth/authority"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-environment-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { defaultControlPlaneCredentials } = await import("../authority/default-credentials")
const { fanoutEligible } = await import("../credentials/account-kinds")
const { SINGLE_TENANT_ORG } = await import("../credentials/partition")
const { projectEnvironment, PROJECT_ENV_MAX_ENTRIES } = await import("./environment")
const { ProjectEnvironmentRoutes } = await import("./environment-routes")
const { ClaxedoDB } = await import("../platform/db/index")

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

const credentials = defaultControlPlaneCredentials()
const unsigned = ProjectEnvironmentRoutes({ authenticate: async () => undefined, credentials: () => credentials })

const put = (value: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })

describe("project environment on the local product", () => {
  test("a set value is stored encrypted, listed by name only, and read back only by the delivery path", async () => {
    expect(await (await unsigned.request("/prj_local/environment/API_URL", put({ value: "https://api.example.test" }))).json())
      .toEqual({ names: ["API_URL"], editable: true })
    const second = await unsigned.request("/prj_local/environment/DATABASE_URL", put({ value: "postgres://secret@db/app" }))
    expect(await second.text()).not.toContain("secret@db")
    const listed = await unsigned.request("/prj_local/environment")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ names: ["API_URL", "DATABASE_URL"], editable: true })

    expect(await projectEnvironment(credentials, SINGLE_TENANT_ORG).values("prj_local"))
      .toEqual({ API_URL: "https://api.example.test", DATABASE_URL: "postgres://secret@db/app" })
    const rows = (await credentials.listCredentials(SINGLE_TENANT_ORG)).filter((row) => row.provider_id.startsWith("project-env:prj_local:"))
    expect(rows.map((row) => [row.owner, row.label, fanoutEligible(row)])).toEqual([[null, "API_URL", false], [null, "DATABASE_URL", false]])
    const files = await fs.readdir(path.join(root, "credentials"))
    for (const file of files) expect(await fs.readFile(path.join(root, "credentials", file), "utf8")).not.toContain("secret@db")
  })

  test("setting a name again replaces its value, and removing it drops it from the list and the delivered environment", async () => {
    await unsigned.request("/prj_replace/environment/TOKEN", put({ value: "first" }))
    await unsigned.request("/prj_replace/environment/TOKEN", put({ value: "second" }))
    await unsigned.request("/prj_replace/environment/KEEP", put({ value: "kept" }))
    expect(await projectEnvironment(credentials, SINGLE_TENANT_ORG).values("prj_replace")).toEqual({ TOKEN: "second", KEEP: "kept" })
    const removed = await unsigned.request("/prj_replace/environment/TOKEN", { method: "DELETE" })
    expect(await removed.json()).toEqual({ names: ["KEEP"], editable: true })
    expect(await projectEnvironment(credentials, SINGLE_TENANT_ORG).values("prj_replace")).toEqual({ KEEP: "kept" })
  })

  test("one project's variables never appear in another's", async () => {
    await unsigned.request("/prj_one/environment/ONLY_ONE", put({ value: "1" }))
    await unsigned.request("/prj_one:two/environment/NESTED", put({ value: "2" }))
    expect(await (await unsigned.request("/prj_two/environment")).json()).toEqual({ names: [], editable: true })
    expect(await projectEnvironment(credentials, SINGLE_TENANT_ORG).values("prj_one")).toEqual({ ONLY_ONE: "1" })
  })

  // Filling the cap stores PROJECT_ENV_MAX_ENTRIES credentials; on Windows each
  // private credential file costs about 360 ms (a PowerShell run writes its DACL).
  test("a name that is not a variable name or is the runtime's own, an empty value and a variable past the cap are refused", { timeout: 90_000 }, async () => {
    const badName = await unsigned.request("/prj_bad/environment/not-a-name", put({ value: "x" }))
    expect(badName.status).toBe(400)
    expect(await badName.json()).toMatchObject({ error: { code: "project_env_invalid" } })
    for (const reserved of ["WORKSPACE_RUNTIME_WORKSPACE_ID", "WORKSPACE_RUNTIME_PROJECT_ENV_NAMES", "claxedo_server_url"]) {
      const refused = await unsigned.request(`/prj_bad/environment/${reserved}`, put({ value: "x" }))
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: "project_env_invalid", message: expect.stringContaining("reserved") } })
    }
    expect(await (await unsigned.request("/prj_bad/environment")).json()).toEqual({ names: [], editable: true })
    expect((await unsigned.request("/prj_bad/environment/EMPTY", put({ value: "" }))).status).toBe(400)
    expect((await unsigned.request("/prj_bad/environment/EXTRA", put({ value: "x", leak: true }))).status).toBe(400)

    const env = projectEnvironment(credentials, SINGLE_TENANT_ORG)
    for (let index = 0; index < PROJECT_ENV_MAX_ENTRIES; index++) await env.set("prj_full", `VAR_${index}`, "x")
    const over = await unsigned.request("/prj_full/environment/ONE_MORE", put({ value: "x" }))
    expect(over.status).toBe(400)
    expect((await env.names("prj_full")).length).toBe(PROJECT_ENV_MAX_ENTRIES)
    expect((await unsigned.request("/prj_big/environment/BIG", put({ value: "x".repeat(40 * 1024) }))).status).toBe(400)
  })
})

describe("project environment behind a signed authority", () => {
  const caller = (subject: string): SignedControlPlaneAuth => ({ mode: "signed", user: { subject, tokenIdentifier: subject, issuer: "https://issuer.test" } })
  const roles: Record<string, { role: ProjectRole; orgId: string }> = {
    owner: { role: "owner", orgId: "org_a" },
    admin: { role: "admin", orgId: "org_a" },
    editor: { role: "editor", orgId: "org_a" },
    viewer: { role: "viewer", orgId: "org_a" },
    other_org_owner: { role: "owner", orgId: "org_b" },
  }
  const rank: Record<ProjectRole | ProjectAction, number> = { viewer: 1, read: 1, editor: 2, write: 2, admin: 3, owner: 4 }
  const authority = {
    authorizeProject: async (auth: SignedControlPlaneAuth, args: { action: ProjectAction }) => {
      const grant = roles[auth.user.subject]
      return grant && rank[grant.role] >= rank[args.action] ? { ok: true, ...grant } : { ok: false }
    },
  } as unknown as WorkspaceAuthority
  const routes = ProjectEnvironmentRoutes({
    authenticate: async (request) => caller(request.headers.get("x-test-user") ?? "stranger"),
    authority,
    credentials: () => credentials,
  })
  const as = (subject: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    ({ ...init, headers: { ...init.headers, "x-test-user": subject } })

  test("admins and owners set and remove; editors and viewers see the names only; anyone else sees nothing", async () => {
    expect((await routes.request("/prj_team/environment/SHARED", as("admin", put({ value: "admin-set" })))).status).toBe(200)
    expect((await routes.request("/prj_team/environment/OWNED", as("owner", put({ value: "owner-set" })))).status).toBe(200)

    for (const subject of ["editor", "viewer"]) {
      expect(await (await routes.request("/prj_team/environment", as(subject))).json()).toEqual({ names: ["OWNED", "SHARED"], editable: false })
      const write = await routes.request("/prj_team/environment/SHARED", as(subject, put({ value: "overwritten" })))
      expect(write.status).toBe(403)
      expect((await routes.request("/prj_team/environment/SHARED", as(subject, { method: "DELETE" }))).status).toBe(403)
    }
    expect(await (await routes.request("/prj_team/environment", as("owner"))).json()).toEqual({ names: ["OWNED", "SHARED"], editable: true })
    const stranger = await routes.request("/prj_team/environment", as("stranger"))
    expect(stranger.status).toBe(404)
    expect(await stranger.text()).not.toContain("SHARED")
    expect(await projectEnvironment(credentials, "org_a").values("prj_team")).toEqual({ OWNED: "owner-set", SHARED: "admin-set" })
  })

  test("each organization's variables live in its own credential partition", async () => {
    await routes.request("/prj_split/environment/ORG_A", as("owner", put({ value: "a" })))
    await routes.request("/prj_split/environment/ORG_B", as("other_org_owner", put({ value: "b" })))
    expect(await projectEnvironment(credentials, "org_a").values("prj_split")).toEqual({ ORG_A: "a" })
    expect(await projectEnvironment(credentials, "org_b").values("prj_split")).toEqual({ ORG_B: "b" })
    expect(await projectEnvironment(credentials, SINGLE_TENANT_ORG).values("prj_split")).toEqual({})
  })

  test("a signed composition with no authority refuses", async () => {
    const bare = ProjectEnvironmentRoutes({ authenticate: async () => caller("owner"), credentials: () => credentials })
    expect((await bare.request("/prj_team/environment")).status).toBe(503)
  })
})
