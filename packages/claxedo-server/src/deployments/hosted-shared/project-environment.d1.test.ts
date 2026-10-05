import { afterEach, expect, test } from "vitest"
import { projectEnvironment } from "@claxedo/server-core/projects/environment"
import { hostedCoreD1App } from "../../test-support/hosted-core-d1-app"

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

async function project() {
  const app = await hostedCoreD1App(disposers)
  const alice = await app.person("alice")
  const bob = await app.person("bob")
  const carol = await app.person("carol")
  const outsider = await app.person("outsider")
  const orgId = ((await app.call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
  const { project_id: projectId } = await app.authority.createWorkspace(alice.auth, {
    workspaceId: "ws_acme",
    orgId,
    displayName: "acme",
    backing: "cloud-vm",
    repoUrl: "https://github.com/acme/app",
  })
  await app.join(alice.token, orgId, bob)
  await app.join(alice.token, orgId, carol)
  expect((await app.call(alice.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: carol.userId, role: "admin" })).status).toBe(200)
  const path = (name?: string) => `/api/claxedo/projects/${projectId}/environment${name ? `/${name}` : ""}`
  return { ...app, alice, bob, carol, outsider, orgId, projectId, path }
}

test("the project's owner and admins set variables; members read the names; the values stay in the encrypted store", async () => {
  const { call, credentials, controlPlane, alice, bob, carol, orgId, projectId, path } = await project()

  expect(await call(alice.token, "PUT", path("DATABASE_URL"), { value: "postgres://secret@db/app" }))
    .toEqual({ status: 200, body: { names: ["DATABASE_URL"], editable: true } })
  expect(await call(carol.token, "PUT", path("API_URL"), { value: "https://api.example.test" }))
    .toEqual({ status: 200, body: { names: ["API_URL", "DATABASE_URL"], editable: true } })

  expect(await call(bob.token, "GET", path())).toEqual({ status: 200, body: { names: ["API_URL", "DATABASE_URL"], editable: false } })
  expect((await call(bob.token, "PUT", path("DATABASE_URL"), { value: "overwritten" })).status).toBe(403)
  expect((await call(bob.token, "DELETE", path("API_URL"))).status).toBe(403)

  expect(await projectEnvironment(credentials(orgId), orgId).values(projectId))
    .toEqual({ DATABASE_URL: "postgres://secret@db/app", API_URL: "https://api.example.test" })
  const stored = await controlPlane.database
    .prepare("select owner, secret_envelope from hosted_provider_credentials where org_id = ? and provider_id like 'project-env:%'")
    .bind(orgId)
    .all<{ owner: string | null; secret_envelope: string }>()
  expect(stored.results.map((row) => row.owner)).toEqual([null, null])
  for (const row of stored.results) expect(row.secret_envelope).not.toContain("secret@db")

  expect(await call(carol.token, "DELETE", path("API_URL"))).toEqual({ status: 200, body: { names: ["DATABASE_URL"], editable: true } })
})

test("someone outside the organization learns nothing and changes nothing, and an unsigned request is refused", async () => {
  const { call, credentials, alice, outsider, orgId, projectId, path } = await project()
  await call(alice.token, "PUT", path("DEPLOY_KEY"), { value: "only-acme" })

  const read = await call(outsider.token, "GET", path())
  expect(read.status).toBe(404)
  expect(JSON.stringify(read.body)).not.toContain("DEPLOY_KEY")
  expect((await call(outsider.token, "PUT", path("DEPLOY_KEY"), { value: "attacker" })).status).toBe(403)
  expect((await call(outsider.token, "DELETE", path("DEPLOY_KEY"))).status).toBe(403)
  expect((await call("nobody", "GET", path())).status).toBe(401)
  expect(await projectEnvironment(credentials(orgId), orgId).values(projectId)).toEqual({ DEPLOY_KEY: "only-acme" })
})
