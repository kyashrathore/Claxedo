import { afterEach, expect, test } from "vitest"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG } from "./index"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

test("two first writes for one owner and provider land on one row under the winner's id", async () => {
  const instance = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(instance)
  const credentials = hostedOrgCredentials("org_1", {
    database: instance.database,
    env: { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 3).toString("base64") },
  })
  const write = { owner: null, provider_id: "github", kind: "api_key" as const, source: "managed" as const }
  const results = await Promise.all([
    credentials.putCredential({ ...write, secret: "first" }),
    credentials.putCredential({ ...write, secret: "second" }),
  ])
  expect(results[0].id).toBe(results[1].id)
  expect(await credentials.listCredentials()).toHaveLength(1)
  expect(["first", "second"]).toContain(await credentials.resolveCredentialSecret!("github"))
})
