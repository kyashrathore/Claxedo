import { describe, expect, test } from "vitest"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import type { CredentialWrite } from "@claxedo/server-core/credentials/types"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/partition"
import { createProviderAuthService, ProviderAuthError } from "./service"
import { ProviderAuthRoutes } from "../routes/provider-auth"

/** A fetch body this suite always sends as JSON text; anything else is a bug in the test. */
function jsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error(`expected a JSON string request body, got ${typeof body}`)
  return JSON.parse(body)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** Records the ORG every credential statement ran as. */
function credentials() {
  const writes: Array<{ input: CredentialWrite; org?: string }> = []
  const deletes: Array<{ providerId: string; org?: string }> = []
  const registry: ControlPlaneCredentials = {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    putCredential: async (input, org) => {
      writes.push({ input, org })
      return {
        id: "cred_1",
        provider_id: input.provider_id,
        kind: input.kind,
        source: input.source,
        label: input.label ?? null,
        account_id: input.account_id ?? null,
        secure_ref: "test:cred_1",
        status: "available",
        expires_at: input.expires_at ?? null,
        last_validated_at: 1,
        last_error: null,
        created_at: 1,
        updated_at: 1,
        revision: 1,
        incarnation: "cred_1",
      }
    },
    deleteCredential: async () => false,
    deleteCredentialsByProvider: async (providerId, _kind, org) => {
      deletes.push({ providerId, org })
      return 0
    },
    updateCredentialStatus: async () => {},
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    accountSelections: async () => ({}),
    setAccountSources: async () => ({}),
  }
  return { writes, deletes, registry }
}

/** Device-flow upstream: usercode → poll → token exchange. */
function upstream(seed: { userCode: string; accessToken: string }) {
  return (async (input: string | URL) => {
    const url = input.toString()
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return json({ device_auth_id: `dev_${seed.userCode}`, user_code: seed.userCode, interval: "1" })
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return json({ authorization_code: "auth_code", code_verifier: "verifier" })
    }
    if (url.endsWith("/oauth/token")) {
      return json({ access_token: seed.accessToken, refresh_token: "refresh_token", expires_in: 3600 })
    }
    return json({ error: "unexpected" }, 404)
  }) as typeof fetch
}

function service(registry: ControlPlaneCredentials, seed = { userCode: "ABCD-EFGH", accessToken: "access_token" }) {
  return createProviderAuthService(registry, {
    now: () => 1_000,
    sleep: async () => {},
    pollingSafetyMs: 0,
    fetch: upstream(seed),
  })
}

describe("a started sign-in opens only for the tenant and person who started it", () => {
  test("another person in the same org cannot complete an authorization", async () => {
    const c = credentials()
    const auth = service(c.registry)
    const { attempt } = (await auth.authorize({ providerId: "codex-app-server", org: "shared-org", owner: "A" }))!
    await expect(auth.callback({ providerId: "codex-app-server", org: "shared-org", owner: "B", attempt }))
      .rejects.toMatchObject({ code: "provider_auth_missing_pending" })
    expect(c.writes).toEqual([])
    await auth.callback({ providerId: "codex-app-server", org: "shared-org", owner: "A", attempt })
    expect(c.writes[0]).toMatchObject({ org: "shared-org", input: { owner: "A" } })
    expect(c.deletes).toEqual([])
  })
  test("org B cannot complete an authorization org A started, nor one started for another provider", async () => {
    const c = credentials()
    const auth = service(c.registry)

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!

    await expect(auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-b", attempt })).rejects.toMatchObject({
      code: "provider_auth_missing_pending",
    })
    await expect(auth.callback({ owner: "local", providerId: "openai", org: "org-a", attempt })).rejects.toMatchObject({
      code: "provider_auth_missing_pending",
    })
    await expect(auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt: `${attempt.slice(0, -4)}AAAA` }))
      .rejects.toMatchObject({ code: "provider_auth_missing_pending" })
    await expect(auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a" })).rejects.toMatchObject({
      code: "provider_auth_missing_pending",
    })
    expect(c.writes).toEqual([])
    expect(c.deletes).toEqual([])

    expect(await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })).toBe(true)
    expect(c.writes).toHaveLength(1)
    expect(c.writes[0].org).toBe("org-a")
  })

  test("two orgs hold concurrent authorizations for the same provider without crossing", async () => {
    const c = credentials()
    let issued = 0
    const exchanged: string[] = []
    const auth = createProviderAuthService(c.registry, {
      now: () => 1_000,
      sleep: async () => {},
      pollingSafetyMs: 0,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        const url = input.toString()
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          issued += 1
          return json({ device_auth_id: `dev-${issued}`, user_code: `CODE-${issued}`, interval: "1" })
        }
        if (url.endsWith("/api/accounts/deviceauth/token")) {
          const body = init?.body === undefined ? {} : jsonBody(init.body)
          const deviceAuthId = body && typeof body === "object" && "device_auth_id" in body ? body.device_auth_id : undefined
          exchanged.push(typeof deviceAuthId === "string" ? deviceAuthId : "")
          return json({ authorization_code: "auth_code", code_verifier: "verifier" })
        }
        if (url.endsWith("/oauth/token")) {
          return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
        }
        return json({ error: "unexpected" }, 404)
      }) as typeof fetch,
    })

    const a = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    const b = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-b" }))!

    await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt: a.attempt })
    await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-b", attempt: b.attempt })
    expect(exchanged).toEqual(["dev-1", "dev-2"])
    expect(c.writes.map((write) => write.org)).toEqual(["org-a", "org-b"])
  })

  test("the callback upserts its account without deleting other accounts", async () => {
    const c = credentials()
    const auth = service(c.registry)
    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })

    expect(c.deletes).toEqual([])
    expect(c.writes[0].org).toBe("org-a")
  })

  test("POSITIVE CONTROL: the single-tenant (unsigned self-host) flow still completes", async () => {
    const c = credentials()
    const auth = service(c.registry)

    const authorization = (await auth.authorize({ owner: "local", providerId: "codex-app-server" }))!
    expect(authorization).toMatchObject({ instructions: "Enter code: ABCD-EFGH", method: "auto" })
    expect(authorization.attempt).not.toContain("dev_ABCD-EFGH")
    expect(await auth.callback({ owner: "local", providerId: "codex-app-server", attempt: authorization.attempt })).toBe(true)

    // A blank org is NOT a wildcard: it collapses to the named single-tenant
    // partition, the same one the credential router resolves unsigned to.
    expect(c.deletes).toEqual([])
    expect(c.writes[0].org).toBe(SINGLE_TENANT_ORG)
    expect(c.writes[0].input).toMatchObject({ provider_id: "codex-app-server", kind: "oauth_token" })
  })

  test("an unclaimed authorization expires instead of lingering forever", async () => {
    const c = credentials()
    let now = 1_000
    const auth = createProviderAuthService(c.registry, {
      now: () => now,
      sleep: async () => {},
      pollingSafetyMs: 0,
      pendingTtlMs: 60_000,
      fetch: upstream({ userCode: "ABCD-EFGH", accessToken: "access_token" }),
    })

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    now += 60_001
    await expect(auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })).rejects.toBeInstanceOf(
      ProviderAuthError,
    )
    expect(c.writes).toEqual([])
  })
})

describe("device polling cannot hold a callback open forever", () => {
  /** Upstream that issues a code, then answers "still pending" forever, clock ticking one interval per poll. */
  function neverApproved(tick: () => void) {
    return (async (input: string | URL) => {
      const url = input.toString()
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return json({ device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "1" })
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        tick()
        return json({ error: "authorization_pending" }, 403)
      }
      return json({ error: "unexpected" }, 404)
    }) as typeof fetch
  }

  test("a provider that never approves fails the poll at the authorization's expiry", async () => {
    const c = credentials()
    let now = 1_000
    let polls = 0
    const auth = createProviderAuthService(c.registry, {
      now: () => now,
      sleep: async () => {},
      pollingSafetyMs: 0,
      pendingTtlMs: 10_000,
      fetch: neverApproved(() => {
        polls += 1
        now += 1_000
      }),
    })

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    await expect(auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })).rejects.toMatchObject({
      code: "provider_auth_callback_expired",
    })
    // Bounded: ten 1s-interval polls inside the 10s TTL, not an open loop.
    expect(polls).toBeLessThanOrEqual(10)
    expect(c.writes).toEqual([])
  })

  test("a client disconnect wakes the inter-poll wait and ends the callback", async () => {
    const c = credentials()
    const abort = new AbortController()
    const auth = createProviderAuthService(c.registry, {
      now: () => 1_000,
      // Never resolves: only the abort can release the wait between polls.
      sleep: () => new Promise<void>(() => {}),
      pollingSafetyMs: 0,
      pendingTtlMs: 60_000,
      fetch: (async (input: string | URL) => {
        const url = input.toString()
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          return json({ device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "1" })
        }
        if (url.endsWith("/api/accounts/deviceauth/token")) {
          abort.abort()
          return json({ error: "authorization_pending" }, 403)
        }
        return json({ error: "unexpected" }, 404)
      }) as typeof fetch,
    })

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    await expect(
      auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt, signal: abort.signal }),
    ).rejects.toMatchObject({ code: "provider_auth_callback_aborted" })
    expect(c.writes).toEqual([])
  })

  test("an approval landing just inside the expiry still completes", async () => {
    const c = credentials()
    let now = 1_000
    const auth = createProviderAuthService(c.registry, {
      now: () => now,
      sleep: async () => {},
      pollingSafetyMs: 0,
      pendingTtlMs: 60_000,
      fetch: upstream({ userCode: "ABCD-EFGH", accessToken: "access_token" }),
    })

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    now = 60_999
    expect(await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })).toBe(true)
    expect(c.writes).toHaveLength(1)
  })
})

describe("provider-auth routes resolve the tenant the same way credential routes do", () => {
  function app(registry: ControlPlaneCredentials, resolveOrg: (request: Request) => string) {
    const auth = service(registry)
    return ProviderAuthRoutes({
      service: auth,
      resolveOrg,
    })
  }

  const post = (body: unknown = { method: 0 }) => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })

  test("an authorization started as org A cannot be completed by a request resolving to org B", async () => {
    const c = credentials()
    let org = "org-a"
    const routes = app(c.registry, () => org)

    const started = await routes.request("/provider/codex-app-server/oauth/authorize", post())
    expect(started.status).toBe(200)
    const { attempt } = await started.json() as { attempt: string }

    org = "org-b"
    const stolen = await routes.request("/provider/codex-app-server/oauth/callback", post({ method: 0, attempt }))
    expect(stolen.status).toBe(400)
    expect(await stolen.json()).toMatchObject({ error: { code: "provider_auth_missing_pending" } })
    expect(c.writes).toEqual([])

    org = "org-a"
    const rightful = await routes.request("/provider/codex-app-server/oauth/callback", post({ method: 0, attempt }))
    expect(rightful.status).toBe(200)
    expect(c.writes[0].org).toBe("org-a")
  })

  test("POSITIVE CONTROL: unsigned local requests complete and land in the single-tenant partition", async () => {
    const c = credentials()
    // No resolveOrg override: unsigned local auth config resolves to __local__.
    const routes = ProviderAuthRoutes({
      service: service(c.registry),
      authConfig: { enabled: false, mode: "local-only", reason: "test" },
    })

    const started = await routes.request("/provider/codex-app-server/oauth/authorize", post())
    const { attempt } = await started.json() as { attempt: string }
    const done = await routes.request("/provider/codex-app-server/oauth/callback", post({ method: 0, attempt }))
    expect(done.status).toBe(200)
    expect(await done.json()).toBe(true)
    expect(c.writes[0].org).toBe(SINGLE_TENANT_ORG)
    expect(c.deletes).toEqual([])
  })
})

describe("what a completed ChatGPT sign-in leaves behind", () => {
  const jwt = (claims: Record<string, unknown>) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`

  /** Device flow whose token exchange returns an id_token carrying the account's claims. */
  function chatgpt(claims: Record<string, unknown>) {
    return (async (input: string | URL) => {
      const url = input.toString()
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return json({ device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "1" })
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return json({ authorization_code: "auth_code", code_verifier: "verifier" })
      }
      if (url.endsWith("/oauth/token")) {
        return json({ id_token: jwt(claims), access_token: "access", refresh_token: "refresh", expires_in: 3600 })
      }
      return json({ error: "unexpected" }, 404)
    }) as typeof fetch
  }

  test("the Codex harness's own row, named by the account, and nothing on the engine's provider", async () => {
    const c = credentials()
    const auth = createProviderAuthService(c.registry, {
      now: () => 1_000,
      sleep: async () => {},
      pollingSafetyMs: 0,
      fetch: chatgpt({ email: "person@example.com", chatgpt_account_id: "acct_9" }),
    })

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    expect(await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })).toBe(true)

    expect(c.writes).toHaveLength(1)
    expect(c.writes[0].input).toMatchObject({
      provider_id: "codex-app-server",
      kind: "oauth_token",
      source: "managed",
      label: "person@example.com",
      account_id: "acct_9",
    })
    // `openai` is the vendor an engine runs models from; a Codex login is not one.
    expect(c.writes.map((write) => write.input.provider_id)).not.toContain("openai")
    expect(c.deletes).toEqual([])

    const secret: unknown = JSON.parse(c.writes[0].input.secret)
    expect(secret).toMatchObject({ type: "codex_auth", auth_mode: "chatgpt", account_id: "acct_9" })
  })

  test("a login whose claims name no address still stores, under words a reader can place", async () => {
    const c = credentials()
    const auth = createProviderAuthService(c.registry, {
      now: () => 1_000,
      sleep: async () => {},
      pollingSafetyMs: 0,
      fetch: chatgpt({ chatgpt_account_id: "acct_9" }),
    })

    const { attempt } = (await auth.authorize({ owner: "local", providerId: "codex-app-server", org: "org-a" }))!
    await auth.callback({ owner: "local", providerId: "codex-app-server", org: "org-a", attempt })
    expect(c.writes[0].input.label).toBe("ChatGPT OAuth")
  })
})
