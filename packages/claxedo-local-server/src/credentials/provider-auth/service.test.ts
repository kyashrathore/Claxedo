import { describe, expect, test } from "vitest"
import type { ControlPlaneCredentials, ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { CredentialWrite } from "@claxedo/server-core/credentials/types"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"
import { createProviderAuthService, ProviderAuthError } from "./service"
import { ProviderAuthRoutes } from "../routes/provider-auth"

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
      }
    },
    deleteCredential: async () => false,
    deleteCredentialsByProvider: async (providerId, _kind, org) => {
      deletes.push({ providerId, org })
      return 0
    },
    updateCredentialStatus: async () => {},
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
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

describe("OAuth pending state is keyed by tenant", () => {
  test("org B cannot consume an authorization org A started", async () => {
    const c = credentials()
    const auth = service(c.registry)

    await auth.authorize({ providerId: "codex-app-server", org: "org-a" })

    // Same provider, different tenant: as far as org B is concerned nothing
    // was ever started — it cannot take delivery of org A's login.
    await expect(auth.callback({ providerId: "codex-app-server", org: "org-b" })).rejects.toMatchObject({
      code: "provider_auth_missing_pending",
    })
    expect(c.writes).toEqual([])
    expect(c.deletes).toEqual([])

    // Org A's authorization is untouched and still completes.
    expect(await auth.callback({ providerId: "codex-app-server", org: "org-a" })).toBe(true)
    expect(c.writes).toHaveLength(1)
    expect(c.writes[0]!.org).toBe("org-a")
  })

  test("two orgs hold concurrent authorizations for the same provider without crossing", async () => {
    const c = credentials()
    let issued = 0
    const exchanged: string[] = []
    // One service instance = one pending map, which is exactly where the
    // collision lived: keyed by providerId alone, org B's `authorize` silently
    // EVICTED org A's in-flight authorization.
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
          const body = JSON.parse(String(init?.body ?? "{}")) as { device_auth_id?: string }
          exchanged.push(body.device_auth_id ?? "")
          return json({ authorization_code: "auth_code", code_verifier: "verifier" })
        }
        if (url.endsWith("/oauth/token")) {
          return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
        }
        return json({ error: "unexpected" }, 404)
      }) as typeof fetch,
    })

    await auth.authorize({ providerId: "codex-app-server", org: "org-a" })
    await auth.authorize({ providerId: "codex-app-server", org: "org-b" })

    // Each tenant completes ITS OWN device authorization, not the other's.
    await auth.callback({ providerId: "codex-app-server", org: "org-a" })
    await auth.callback({ providerId: "codex-app-server", org: "org-b" })
    expect(exchanged).toEqual(["dev-1", "dev-2"])
    expect(c.writes.map((write) => write.org)).toEqual(["org-a", "org-b"])
  })

  test("the callback's destructive write is scoped to the caller's org", async () => {
    const c = credentials()
    const auth = service(c.registry)
    await auth.authorize({ providerId: "codex-app-server", org: "org-a" })
    await auth.callback({ providerId: "codex-app-server", org: "org-a" })

    // deleteCredentialsByProvider wipes every credential for the provider; run
    // unscoped it would wipe every OTHER tenant's login for that provider too.
    expect(c.deletes).toEqual([{ providerId: "codex-app-server", org: "org-a" }])
    expect(c.writes[0]!.org).toBe("org-a")
  })

  test("POSITIVE CONTROL: the single-tenant (unsigned self-host) flow still completes", async () => {
    const c = credentials()
    const auth = service(c.registry)

    const authorization = await auth.authorize({ providerId: "codex-app-server" })
    expect(authorization).toMatchObject({ instructions: "Enter code: ABCD-EFGH", method: "auto" })
    expect(await auth.callback({ providerId: "codex-app-server" })).toBe(true)

    // A blank org is NOT a wildcard: it collapses to the named single-tenant
    // partition, the same one the credential router resolves unsigned to.
    expect(c.deletes).toEqual([{ providerId: "codex-app-server", org: SINGLE_TENANT_ORG }])
    expect(c.writes[0]!.org).toBe(SINGLE_TENANT_ORG)
    expect(c.writes[0]!.input).toMatchObject({ provider_id: "codex-app-server", kind: "oauth_token" })
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

    await auth.authorize({ providerId: "codex-app-server", org: "org-a" })
    now += 60_001
    await expect(auth.callback({ providerId: "codex-app-server", org: "org-a" })).rejects.toBeInstanceOf(
      ProviderAuthError,
    )
    expect(c.writes).toEqual([])
  })
})

describe("provider-auth routes resolve the tenant the same way credential routes do", () => {
  function app(registry: ControlPlaneCredentials, resolveOrg: (request: Request) => string) {
    const auth = service(registry)
    return ProviderAuthRoutes({ credentials: registry } as unknown as ControlPlaneServicesContract, {
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

    expect((await routes.request("/provider/codex-app-server/oauth/authorize", post())).status).toBe(200)

    org = "org-b"
    const stolen = await routes.request("/provider/codex-app-server/oauth/callback", post())
    expect(stolen.status).toBe(400)
    expect(await stolen.json()).toMatchObject({ error: { code: "provider_auth_missing_pending" } })
    expect(c.writes).toEqual([])

    org = "org-a"
    const rightful = await routes.request("/provider/codex-app-server/oauth/callback", post())
    expect(rightful.status).toBe(200)
    expect(c.writes[0]!.org).toBe("org-a")
  })

  test("POSITIVE CONTROL: unsigned local requests complete and land in the single-tenant partition", async () => {
    const c = credentials()
    // No resolveOrg override: unsigned local auth config resolves to __local__.
    const routes = ProviderAuthRoutes({ credentials: c.registry } as unknown as ControlPlaneServicesContract, {
      service: service(c.registry),
      authConfig: { enabled: false, mode: "local-only", reason: "test" },
    })

    expect((await routes.request("/provider/codex-app-server/oauth/authorize", post())).status).toBe(200)
    const done = await routes.request("/provider/codex-app-server/oauth/callback", post())
    expect(done.status).toBe(200)
    expect(await done.json()).toBe(true)
    expect(c.writes[0]!.org).toBe(SINGLE_TENANT_ORG)
    expect(c.deletes).toEqual([{ providerId: "codex-app-server", org: SINGLE_TENANT_ORG }])
  })
})
