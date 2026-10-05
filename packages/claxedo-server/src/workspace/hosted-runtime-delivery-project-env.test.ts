import { afterEach, expect, test } from "vitest"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { projectEnvironment } from "@claxedo/server-core/projects/environment"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { unusedSandboxStart } from "../test-support/inline-sandbox-start"

type Input = Parameters<typeof createHostedRuntimeDelivery>[0]

const ENV = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

async function setup() {
  const instance = await workspaceBackingDatabase([{ id: "ws_cloud", backing: "cloud-vm" }, { id: "ws_machine", backing: "local-worktree" }])
  active.push(instance)
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database: instance.database, env: ENV })
  const delivery = createHostedRuntimeDelivery({
      sandboxStart: unusedSandboxStart,
    authority: {
      resolveWorkspaceOwner: async () => ({ userId: "owner", actorId: "act_owner", orgId: "org", projectId: "project" }),
    } as unknown as Input["authority"],
    database: instance.database,
    services: {} as Input["services"],
    sandboxManager: {} as Input["sandboxManager"],
    workspaceDriver: async () => ({ driver: { metadata: { secretBrokering: "native" } }, key: "operator" }) as Awaited<ReturnType<Input["workspaceDriver"]>>,
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => ({ version: 3, connections: {} }), write: async () => {} },
    credentials,
    signingEnv: {},
    provisionedRunner: "pi",
  })
  return { instance, delivery, environment: projectEnvironment(credentials("org"), "org"), credentials }
}

test("a cloud workspace starts with its project's variables, read from ciphertext the database alone cannot open", async () => {
  const { instance, delivery, environment, credentials } = await setup()
  await environment.set("project", "DATABASE_URL", "postgres://secret@db/app")
  await environment.set("project", "API_URL", "https://api.example.test")
  await projectEnvironment(credentials("org"), "org").set("other_project", "OTHER", "not-this-one")
  await projectEnvironment(credentials("org_elsewhere"), "org_elsewhere").set("project", "FOREIGN", "not-this-org")

  expect((await delivery.prepareRuntime({ workspaceId: "ws_cloud" })).env)
    .toEqual({ DATABASE_URL: "postgres://secret@db/app", API_URL: "https://api.example.test" })
  const stored = await instance.database
    .prepare("select secret_envelope from hosted_provider_credentials where provider_id like 'project-env:%'")
    .all<{ secret_envelope: string }>()
  expect(stored.results).toHaveLength(4)
  for (const row of stored.results) expect(row.secret_envelope).not.toContain("secret@db")
})

test("a removed variable is gone from the next start, and a machine-placed workspace gets nothing from the hosted plane", async () => {
  const { delivery, environment } = await setup()
  await environment.set("project", "TOKEN", "t")
  await environment.set("project", "KEEP", "k")
  await environment.remove("project", "TOKEN")
  expect((await delivery.prepareRuntime({ workspaceId: "ws_cloud" })).env).toEqual({ KEEP: "k" })
  expect(await delivery.prepareRuntime({ workspaceId: "ws_machine" })).toEqual({})
})
