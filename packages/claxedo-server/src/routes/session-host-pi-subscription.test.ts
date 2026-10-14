import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { parseTurnDelivery } from "@claxedo/harness/contract"
import { PiCredentials } from "@claxedo/harness/pi-durable/credentials"
import { sessionAccountCredentials } from "@claxedo/harness/registry"
import { envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { hostedCredentialRoutes } from "../credentials/worker/routes"
import { sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

/**
 * The hosted Pi turn's credential path, end to end: the Claude subscription
 * token the owner pastes in Settings, the control plane's `/turn-delivery`
 * for the session's host, the credentials the host composes for Pi, and the
 * request pi-ai's Anthropic client sends with them. pi-ai sends a credential
 * as a bearer only when it contains `sk-ant-oat` and as `x-api-key`
 * otherwise, so anything stored as a subscription that is not that token is
 * refused by Anthropic as an "invalid x-api-key" on every turn.
 */
let plane: SessionHostPlane
const ROOT = "ses_pi_subscription"
const SETUP_TOKEN = "sk-ant-oat01-setup-token-from-claude-setup-token"
const MODEL = { providerID: "pi", modelID: "anthropic/claude-sonnet-5-5" }

beforeAll(async () => {
  plane = await sessionHostPlane()
})

afterAll(async () => {
  await plane.close()
})

function settings() {
  const authentication: RequestAuthenticationAdapter = {
    descriptor: {} as RequestAuthenticationAdapter["descriptor"],
    authenticate: async () => plane.owner.principal!,
  }
  return hostedCredentialRoutes({
    authentication,
    authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" },
    resolveOrgId: async () => plane.orgId,
    credentials: plane.credentials,
    changed: async () => {},
    keys: envelopeKeyProviderFromEnv(plane.env),
  })
}

const pasteSubscriptionToken = async (secret: string) => {
  const response = await settings().request("https://cp.test/api/claxedo/credentials", {
    method: "PUT",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ provider_id: "claude-sdk", kind: "oauth_token", source: "managed", label: "contactyash", secret }),
  })
  return [response.status, await response.json()] as const
}

/** What a request to Anthropic carried, from pi-ai's Anthropic client with the session's credentials and a refusing vendor. */
async function anthropicRequest(credentials: PiCredentials) {
  const requests: Array<{ url: string; authorization: string | null; apiKey: string | null }> = []
  const vendor = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    requests.push({ url: String(input instanceof Request ? input.url : input), authorization: headers.get("authorization"), apiKey: headers.get("x-api-key") })
    return Response.json({ type: "error", error: { type: "authentication_error", message: "refused by the test vendor" } }, { status: 401 })
  }, { preconnect() {} }) as typeof fetch
  const model = credentials.models.getModel("anthropic", "claude-sonnet-5-5")
  if (!model) throw new Error("pi-ai's Anthropic catalog no longer lists claude-sonnet-5-5")
  const answer = await credentials.models.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { fetch: vendor, maxRetries: 0 }).result()
  expect(answer.stopReason).toBe("error")
  expect(requests).toHaveLength(1)
  return requests[0]!
}

describe("a Claude subscription token on a hosted Pi turn", () => {
  test("a pasted value that is not the token `claude setup-token` prints is refused at save, naming what it is", async () => {
    expect(await pasteSubscriptionToken("sk-ant-ort01-refresh-token-pasted-by-mistake")).toEqual([400, {
      error: { code: "credential_subscription_token_invalid", message: expect.stringMatching(/refresh token, not its access token.*sk-ant-oat01-/) },
    }])
    expect(await pasteSubscriptionToken("sk-ant-api03-console-key")).toEqual([400, {
      error: { code: "credential_subscription_token_invalid", message: "This is an Anthropic API key. Add it under API Key." },
    }])
    expect(await plane.credentials(plane.orgId).listCredentials()).toEqual([])
  })

  test("the token is delivered to the session's host as the owner's subscription, and pi-ai sends it as a bearer and nothing as x-api-key", async () => {
    const [status] = await pasteSubscriptionToken(` ${SETUP_TOKEN}\n`)
    expect(status).toBe(200)
    const ownerId = plane.owner.principal!.userId
    expect(await plane.credentials(plane.orgId).listCredentials()).toMatchObject([{ provider_id: "claude-sdk", kind: "oauth_token", owner: ownerId }])

    const proof = await plane.createHostedSession(ROOT)
    const lease = await plane.acquire(proof, ROOT, "turn_subscription")
    const delivery = parseTurnDelivery(await (await plane.post("/turn-delivery", { turnLease: lease.leaseId })).json())
    expect(delivery?.auth.direct).toEqual({ [ownerId]: { "claude-sdk": expect.objectContaining({ authKind: "subscription", secret: SETUP_TOKEN, baseUrl: "https://api.anthropic.com" }) } })

    const resolved = sessionAccountCredentials(
      { machineOwnerUserId: delivery!.auth.machineOwnerUserId, accounts: {}, direct: delivery!.auth.direct, placement: "cloud", canUseOwnLogin: false, leaseGeneration: "turn_subscription" },
      { kind: "person", userId: ownerId },
      { harness: { id: "pi", access: "native" }, model: MODEL },
    )
    const credentials = new PiCredentials(resolved, [], async () => undefined)
    expect(credentials.direct("anthropic")?.credentialProviderId).toBe("claude-sdk")
    expect(await anthropicRequest(credentials)).toEqual({ url: "https://api.anthropic.com/v1/messages?beta=true", authorization: `Bearer ${SETUP_TOKEN}`, apiKey: null })
  })

  test("a subscription row holding anything else is what pi-ai sends as x-api-key, which is why the save refuses it", async () => {
    const credentials = new PiCredentials({
      accountOwner: "user", machineLoginAllowed: false, providers: {}, secrets: {}, leaseGeneration: "g",
      direct: { "claude-sdk": { delivery: "direct", baseUrl: "https://api.anthropic.com", apiPath: "/v1", secret: "sk-ant-ort01-refresh-token", authKind: "subscription" } },
    }, [], async () => undefined)
    expect(await anthropicRequest(credentials)).toMatchObject({ authorization: null, apiKey: "sk-ant-ort01-refresh-token" })
  })
})
