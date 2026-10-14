import { afterEach, describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { builtInProviderDestination } from "@claxedo/server-core/credentials/built-in-destinations"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { hostTunnelTokenVerifier } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { createHostedCoreApp } from "../../deployments/hosted-shared/hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "../../deployments/hosted-shared/deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { HOSTED_CREDENTIALS_FLAG, hostedBrokerCredentialReader, hostedOrgCredentials } from "../worker/index"
import { createHostedEgressBroker, HOSTED_EGRESS_BROKER_GUARD_EXEMPTION, verifyBrokerPlaceholder } from "./index"

/**
 * A Boat sandbox's turn, end to end through the composed control plane: the
 * placeholder its runtime was delivered, presented at the binding URL under
 * the plane's origin, reaches a stub vendor with the stored key and streams
 * the vendor's answer back. Everything the broker must refuse is refused by
 * the same composition.
 */

const ORIGIN = "https://core.test"
const CREDENTIAL_ENV = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

type Upstream = { request: Request; body: string }

/** A vendor whose answer is a stream the test releases chunk by chunk. */
function vendor() {
  const seen: Upstream[] = []
  let answer = async (): Promise<Response> => new Response("ok")
  const vendorFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push({ request, body: await request.text() })
    return answer()
  }) as unknown as typeof globalThis.fetch
  return { seen, fetch: vendorFetch, answer: (next: typeof answer) => { answer = next } }
}

async function composition(options: { now?: () => number } = {}) {
  const instance = await miniflareControlPlaneDatabase()
  active.push(instance)
  const database = instance.database as unknown as D1Database
  const signing = await signingEnv()
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database, env: CREDENTIAL_ENV })
  const upstream = vendor()
  const broker = createHostedEgressBroker({
    credentials,
    read: (orgId) => hostedBrokerCredentialReader(orgId, { database, env: CREDENTIAL_ENV }),
    env: signing,
    origin: ORIGIN,
    fetch: upstream.fetch,
    ...(options.now ? { now: options.now } : {}),
  })
  const authentication = testRequestAuthenticationAdapter()
  const sessionAuthority = {
    reserveSession: vi.fn(async () => ({ state: "reserved" })),
    registerRuntimeSession: vi.fn(async () => ({})),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
  }
  const services = {
    auth: { config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" } },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token", hostTunnelTokenVerifier: hostTunnelTokenVerifier(signing) },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async () => "org-1"),
      usersMe: vi.fn(async () => ({ user_id: "alice" })),
      listOrgs: vi.fn(async () => [{ org_id: "org-1" }]),
      listWorkspaces: vi.fn(async () => []),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  const plane = {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6, connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120_000, controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 120_000, defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    privateSessionAuthority: sessionAuthority,
    runtimeSessionAuthority: sessionAuthority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted", CLAXEDO_APP_ORIGINS: "https://app.test", ...signing },
    orgCredentials: credentials,
  } as unknown as HostedControlPlane
  const app = createHostedCoreApp(plane, {
    authentication,
    liveSyncRoom: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
    cloudWorkspaceAdmission: async () => undefined,
    product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
    requestGuardExemptions: [HOSTED_EGRESS_BROKER_GUARD_EXEMPTION],
    egressBroker: broker.handler,
  } as unknown as Parameters<typeof createHostedCoreApp>[1]) as unknown as Hono
  const store = credentials("org-1")
  /** What a push delivers a runtime for one stored account: the binding URL and the placeholder. */
  const delivered = async (credential: CredentialMetadata, workspace: { workspaceId: string; lease?: { epoch: number; hostId: string } }, at?: () => number) => {
    const secret = await store.resolveCredentialSecretById?.(credential.id)
    const destination = builtInProviderDestination({ providerId: credential.provider_id, kind: credential.kind, secret: secret ?? "" })
    if (!destination) throw new Error("the account has no destination")
    const binder = (at ? createHostedEgressBroker({ credentials, read: () => async () => undefined, env: signing, origin: ORIGIN, now: at }) : broker)
      .binder({ orgId: "org-1", workspaceId: workspace.workspaceId, lease: workspace.lease ?? { epoch: 1, hostId: "host_1" } })
    const projection = await binder.bind(credential, destination)
    if ("unavailable" in projection || !projection.placeholder) throw new Error("the account was not bound")
    return { baseUrl: projection.baseUrl, placeholder: projection.placeholder, authMode: projection.authMode, expiresAt: projection.expiresAt }
  }
  return { app, store, upstream, delivered, signing }
}

describe("a sandbox spending its owner's account through the hosted broker", () => {
  test("an API key arrives at the vendor as x-api-key, the placeholder never does, and the answer streams before the vendor is done", async () => {
    const { app, store, upstream, delivered } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-real-key" })
    const { baseUrl, placeholder, authMode } = await delivered(key, { workspaceId: "ws_root" })
    expect(authMode).toBe("api-key")
    expect(baseUrl).toMatch(new RegExp(`^${ORIGIN}/bindings/[0-9a-f]{32}$`))

    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    upstream.answer(async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"))
        await released
        controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {}\n\n"))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream", "anthropic-ratelimit-requests-remaining": "41", "x-api-key": "sk-ant-api03-real-key" } }))

    const response = await app.request(`${baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": placeholder, "anthropic-version": "2023-06-01", "content-type": "application/json", cookie: "sandbox=private" },
      body: JSON.stringify({ model: "claude", messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("41")
    expect(response.headers.get("x-api-key")).toBeNull()
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("message_start")
    release()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("message_stop")
    expect((await reader.read()).done).toBe(true)

    expect(upstream.seen).toHaveLength(1)
    const [sent] = upstream.seen
    expect(sent.request.url).toBe("https://api.anthropic.com/v1/messages?beta=true")
    expect(sent.request.method).toBe("POST")
    expect(sent.request.headers.get("x-api-key")).toBe("sk-ant-api03-real-key")
    expect(sent.request.headers.get("authorization")).toBeNull()
    expect(sent.request.headers.get("cookie")).toBeNull()
    expect(sent.request.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(sent.body).toBe(JSON.stringify({ model: "claude", messages: [] }))
    expect(JSON.stringify([...sent.request.headers])).not.toContain(placeholder)
  })

  test("a Claude subscription arrives as a bearer, and a body past the default cap streams through", async () => {
    const { app, store, upstream, delivered } = await composition()
    const login = await store.putCredential({
      owner: "alice", provider_id: "claude-sdk", kind: "oauth_token", source: "managed",
      secret: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-real-token" } }),
    })
    const { baseUrl, placeholder, authMode } = await delivered(login, { workspaceId: "ws_root" })
    expect(authMode).toBe("bearer")
    const body = "x".repeat(2 * 1024 * 1024)
    const response = await app.request(`${baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${placeholder}` }, body })
    expect(response.status).toBe(200)
    expect(upstream.seen[0].request.headers.get("authorization")).toBe("Bearer sk-ant-oat01-real-token")
    expect(upstream.seen[0].body).toHaveLength(body.length)
  })

  test("a method or path outside the vendor's policy never reaches the vendor", async () => {
    const { app, store, upstream, delivered } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-real-key" })
    const { baseUrl, placeholder } = await delivered(key, { workspaceId: "ws_root" })
    for (const [method, path] of [["DELETE", "/v1/messages"], ["POST", "/v1/files"], ["GET", "/v1/organizations/me"]] as const) {
      const response = await app.request(`${baseUrl}${path}`, { method, headers: { "x-api-key": placeholder } })
      expect([response.status, (await response.json() as { error: { code: string } }).error.code], `${method} ${path}`).toEqual([403, "request_outside_policy"])
    }
    expect(upstream.seen).toHaveLength(0)
  })

  test("an expired placeholder, a forged one, and no placeholder at all are 401", async () => {
    const { app, store, upstream, delivered } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-real-key" })
    const { baseUrl } = await delivered(key, { workspaceId: "ws_root" })
    const expired = await delivered(key, { workspaceId: "ws_root" }, () => Date.now() - 2 * 60 * 60 * 1000)
    const refused = async (headers: Record<string, string>) => {
      const response = await app.request(`${baseUrl}/v1/messages`, { method: "POST", headers, body: "{}" })
      return [response.status, (await response.json() as { error: { code: string } }).error.code]
    }
    expect(await refused({ "x-api-key": expired.placeholder })).toEqual([401, "runtime_token_invalid"])
    expect(await refused({ "x-api-key": "sk-ant-api03-guess" })).toEqual([401, "runtime_token_invalid"])
    expect(await refused({})).toEqual([401, "runtime_token_required"])
    expect(upstream.seen).toHaveLength(0)
  })

  test("a placeholder spends only the binding it was minted for: not another workspace's, not another person's", async () => {
    const { app, store, upstream, delivered } = await composition()
    const alice = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-alice" })
    const bob = await store.putCredential({ owner: "bob", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-bob" })
    const root = await delivered(alice, { workspaceId: "ws_root" })
    const other = await delivered(alice, { workspaceId: "ws_other" })
    const bobs = await delivered(bob, { workspaceId: "ws_root" })
    expect(new Set([root.baseUrl, other.baseUrl, bobs.baseUrl]).size).toBe(3)
    const at = async (baseUrl: string, placeholder: string) => {
      const response = await app.request(`${baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": placeholder }, body: "{}" })
      return [response.status, (await response.json() as { error: { code: string } }).error.code]
    }
    expect(await at(root.baseUrl, other.placeholder)).toEqual([403, "binding_not_permitted"])
    expect(await at(root.baseUrl, bobs.placeholder)).toEqual([403, "binding_not_permitted"])
    expect(await at(bobs.baseUrl, root.placeholder)).toEqual([403, "binding_not_permitted"])
    expect(upstream.seen).toHaveLength(0)
  })

  test("a withdrawn account refuses the next request, and a rotated one is spent at its new value under the same placeholder", async () => {
    const { app, store, upstream, delivered } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-first" })
    const { baseUrl, placeholder } = await delivered(key, { workspaceId: "ws_root" })
    const spend = () => app.request(`${baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": placeholder }, body: "{}" })

    expect((await spend()).status).toBe(200)
    expect(await store.updateCredentialSecret?.(key.id, "sk-ant-api03-second")).toBe(true)
    expect((await spend()).status).toBe(200)
    expect(upstream.seen.map((sent) => sent.request.headers.get("x-api-key"))).toEqual(["sk-ant-api03-first", "sk-ant-api03-second"])

    await store.updateCredentialStatus(key.id, "revoked")
    const withdrawn = await spend()
    expect([withdrawn.status, (await withdrawn.json() as { error: { code: string } }).error.code]).toEqual([403, "binding_unavailable"])
    await store.deleteCredential(key.id)
    expect((await spend()).status).toBe(403)
    expect(upstream.seen).toHaveLength(2)
  })

  test("two vendor 401s on one stored value mark the account, one does not; a 403 marks nothing", async () => {
    const { app, store, upstream, delivered } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-real-key" })
    const { baseUrl, placeholder } = await delivered(key, { workspaceId: "ws_root" })
    const spend = () => app.request(`${baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": placeholder }, body: "{}" })
    const health = async () => (await store.getCredential?.(key.id))?.health ?? null

    upstream.answer(async () => new Response("forbidden", { status: 403 }))
    expect((await spend()).status).toBe(403)
    expect(await health()).toBeNull()
    upstream.answer(async () => new Response("unauthorized", { status: 401 }))
    expect((await spend()).status).toBe(401)
    expect(await health()).toBeNull()
    expect((await spend()).status).toBe(401)
    expect(await health()).toBe("auth_failed")
  })

  test("no browser origin is granted the broker, while the rest of the plane keeps its allow-list", async () => {
    const { app, store, delivered } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-real-key" })
    const { baseUrl, placeholder } = await delivered(key, { workspaceId: "ws_root" })
    const brokered = await app.request(`${baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": placeholder, origin: "https://app.test" }, body: "{}" })
    expect(brokered.status).toBe(200)
    expect(brokered.headers.get("access-control-allow-origin")).toBeNull()
    const preflight = await app.request(`${baseUrl}/v1/messages`, { method: "OPTIONS", headers: { origin: "https://app.test", "access-control-request-method": "POST" } })
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
    const health = await app.request(`${ORIGIN}/api/claxedo/health`, { headers: { origin: "https://app.test" } })
    expect(health.headers.get("access-control-allow-origin")).toBe("https://app.test")
  })

  test("the placeholder is a pass naming the runtime, the binding and the account, and expires within the hour", async () => {
    const { store, delivered, signing } = await composition()
    const key = await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-real-key" })
    const before = Date.now()
    const { baseUrl, placeholder, expiresAt } = await delivered(key, { workspaceId: "ws_root", lease: { epoch: 4, hostId: "host_4" } })
    expect(await verifyBrokerPlaceholder(placeholder, signing)).toEqual({
      userId: "alice", orgId: "org-1", workspaceId: "ws_root",
      leaseId: "sandbox:ws_root", leaseGeneration: 4, runtimeId: "host_4",
      bindingIds: [baseUrl.slice(baseUrl.lastIndexOf("/") + 1)],
      exp: Math.floor(expiresAt! / 1_000),
      credentialId: key.id,
    })
    expect(expiresAt! - before).toBeGreaterThan(59 * 60 * 1000)
    expect(expiresAt! - before).toBeLessThanOrEqual(60 * 60 * 1000 + 1_000)
    expect(placeholder).not.toContain("sk-ant")
  })
})
