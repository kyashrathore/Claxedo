import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "./worker/index"
import { piDirectRows } from "./pi-direct-rows"

const env = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 5).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }
let controlPlane: ControlPlaneDatabase

beforeAll(async () => {
  controlPlane = await miniflareControlPlaneDatabase()
})

afterAll(async () => {
  await controlPlane.dispose()
})

describe("the accounts an owner's in-process Pi spends", () => {
  test("are their own Pi accounts as secrets, and an account that cannot be read leaves only its own provider without one", async () => {
    const credentials = hostedOrgCredentials("org_pi", { database: controlPlane.database, env })
    await credentials.putCredential({ owner: "owner", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner" })
    await credentials.putCredential({ owner: "owner", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-owner" })
    await credentials.putCredential({ owner: "owner", provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "cursor-owner" })
    await credentials.putCredential({ owner: "someone-else", provider_id: "groq", kind: "api_key", source: "managed", secret: "gsk-other" })
    expect(Object.keys(await piDirectRows(credentials, "owner")).toSorted()).toEqual(["anthropic", "openai"])

    await controlPlane.database.prepare("update hosted_provider_credentials set secret_envelope = 'unreadable' where provider_id = 'openai'").run()
    const rows = await piDirectRows(credentials, "owner")
    expect(rows).toEqual({ anthropic: expect.objectContaining({ secret: "sk-ant-api03-owner" }) })
  })
})
