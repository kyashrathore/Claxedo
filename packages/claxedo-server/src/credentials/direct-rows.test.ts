import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "./worker/index"
import { ownerDirectRows, PI_DIRECT_PROVIDERS } from "./direct-rows"

const env = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 5).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }
let controlPlane: ControlPlaneDatabase

beforeAll(async () => {
  controlPlane = await miniflareControlPlaneDatabase()
})

afterAll(async () => {
  await controlPlane.dispose()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the accounts an owner's in-process Pi spends", () => {
  test("are their own Pi accounts as secrets, and an account that cannot be read leaves only its own provider without one", async () => {
    const credentials = hostedOrgCredentials("org_pi", { database: controlPlane.database, env })
    await credentials.putCredential({ owner: "owner", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner" })
    await credentials.putCredential({ owner: "owner", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-owner" })
    await credentials.putCredential({ owner: "owner", provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "cursor-owner" })
    await credentials.putCredential({ owner: "someone-else", provider_id: "groq", kind: "api_key", source: "managed", secret: "gsk-other" })
    expect(Object.keys(await ownerDirectRows(credentials, "owner", { providers: PI_DIRECT_PROVIDERS })).toSorted()).toEqual(["anthropic", "openai"])

    await controlPlane.database.prepare("update hosted_provider_credentials set secret_envelope = 'unreadable' where provider_id = 'openai'").run()
    const rows = await ownerDirectRows(credentials, "owner", { providers: PI_DIRECT_PROVIDERS })
    expect(rows).toEqual({ anthropic: expect.objectContaining({ secret: "sk-ant-api03-owner" }) })
  })

  test("a ChatGPT plan close to expiring is renewed in the store first, and only its access token is handed over", async () => {
    const credentials = hostedOrgCredentials("org_plan", { database: controlPlane.database, env })
    const access = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`
    const renewedAt = Math.floor(Date.now() / 1000) + 3600
    const exchanged: string[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      exchanged.push(`${url} ${typeof init.body === "string" ? init.body : ""}`)
      return Response.json({ access_token: access(renewedAt), refresh_token: "refresh-2" })
    })
    await credentials.putCredential({
      owner: "owner", provider_id: "codex-app-server", kind: "oauth_token", source: "managed", expires_at: Date.now() + 60_000,
      secret: JSON.stringify({ type: "codex_auth", tokens: { access_token: "access-1", refresh_token: "refresh-1", account_id: "acct" }, access: "access-1", refresh: "refresh-1" }),
    })
    const rows = await ownerDirectRows(credentials, "owner", { providers: PI_DIRECT_PROVIDERS })
    expect(rows["codex-app-server"]).toMatchObject({ secret: access(renewedAt), authKind: "subscription", expiresAt: renewedAt * 1000 })
    expect(JSON.stringify(rows)).not.toContain("refresh-")
    expect(exchanged).toEqual([expect.stringContaining("refresh_token=refresh-1")])
    expect(await ownerDirectRows(credentials, "owner", { providers: PI_DIRECT_PROVIDERS })).toEqual(rows)
    expect(exchanged).toHaveLength(1)
  })
})
