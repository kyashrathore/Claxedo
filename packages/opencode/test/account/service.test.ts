import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import {
  AccessToken,
  AccountID,
  AccountServiceError,
  AccountTransportError,
  DeviceCode,
  Login,
  NativeLoginBinding,
  Org,
  OrgID,
  RefreshToken,
  UserCode,
} from "../../src/account/schema"
import { Database } from "@opencode-ai/core/database/database"
import { AccountTable } from "@opencode-ai/core/account/sql"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-account", layer: truncate, deps: [Database.node] })

const it = testEffect(LayerNode.compile(LayerNode.group([AccountRepo.node, truncateNode, Database.node])))

const insideEagerRefreshWindow = Duration.toMillis(Duration.minutes(1))
const outsideEagerRefreshWindow = Duration.toMillis(Duration.minutes(10))

const nativeBinding = (origin = "https://one.example.com") => ({
  adapter: "better-auth" as const,
  deploymentId: `deployment:${origin}`,
  configurationVersion: "auth-v1",
  issuer: `${origin}/api/auth`,
  tokenEndpointOrigin: origin,
  controlPlaneOrigin: origin,
  clientId: "claxedo-cli",
  resource: `${origin}/control-plane`,
  scopes: ["offline_access", "workspace:read", "workspace:write"],
  tokenKind: "access-token" as const,
})

const authDescriptor = (origin = "https://one.example.com") => ({
  adapter: "better-auth",
  deploymentId: `deployment:${origin}`,
  configurationVersion: "auth-v1",
  expiresAt: Date.now() + 60_000,
  issuer: `${origin}/api/auth`,
  browser: { trustedOrigins: [origin] },
  native: {
    cli: {
      flow: "device-authorization",
      clientId: "claxedo-cli",
      resource: `${origin}/control-plane`,
      scopes: ["offline_access", "workspace:read", "workspace:write"],
      tokenEndpointOrigin: origin,
      controlPlaneOrigin: origin,
      revocation: {
        protocol: "rfc7009",
        endpoint: `${origin}/api/auth/oauth2/revoke`,
        tokenEndpointAuthMethod: "none",
      },
    },
  },
})

const descriptorResponse = (req: Parameters<typeof HttpClientResponse.fromWeb>[0]) => {
  const url = new URL(req.url)
  return url.pathname === "/api/claxedo/auth/descriptor" ? json(req, authDescriptor(url.origin)) : undefined
}

const live = (client: HttpClient.HttpClient) =>
  LayerNode.compile(Account.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]])

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const encodeOrg = Schema.encodeSync(Org)

const org = (id: string, name: string) => encodeOrg(new Org({ id: OrgID.make(id), name }))

const login = () =>
  new Login({
    code: DeviceCode.make("device-code"),
    user: UserCode.make("user-code"),
    url: "https://one.example.com/verify",
    server: "https://one.example.com",
    expiry: Duration.seconds(600),
    interval: Duration.seconds(5),
    binding: new NativeLoginBinding({
      ...nativeBinding(),
      flow: "device-authorization",
      descriptorExpiresAt: Date.now() + 60_000,
    }),
  })

const deviceTokenClient = (body: unknown, status = 400) =>
  HttpClient.make((req) =>
    Effect.succeed(
      descriptorResponse(req) ??
        (req.url === "https://one.example.com/api/auth/oauth2/token" ? json(req, body, status) : json(req, {}, 404)),
    ),
  )

const poll = (body: unknown, status = 400) =>
  Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(deviceTokenClient(body, status))))

it.live("login normalizes trailing slashes in the provided server URL", () =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        const discovery = descriptorResponse(req)
        if (discovery) return discovery

        if (req.url === "https://one.example.com/api/auth/device/code") {
          expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded")
          if (req.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${req.body._tag}`)
          const body = new URLSearchParams(new TextDecoder().decode(req.body.body))
          expect(Object.fromEntries(body)).toEqual({
            client_id: "claxedo-cli",
            resource: "https://one.example.com/control-plane",
            scope: "offline_access workspace:read workspace:write",
          })
          return json(req, {
            device_code: "device-code",
            user_code: "user-code",
            verification_uri_complete: "https://one.example.com/device?user_code=user-code",
            expires_in: 600,
            interval: 5,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use.login("https://one.example.com/").pipe(Effect.provide(live(client)))

    expect(seen).toEqual([
      "GET https://one.example.com/api/claxedo/auth/descriptor",
      "POST https://one.example.com/api/auth/device/code",
    ])
    expect(result.server).toBe("https://one.example.com")
    expect(result.url).toBe("https://one.example.com/device?user_code=user-code")
  }),
)

it.live("login maps transport failures to account transport errors", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req }),
        }),
      ),
    )

    const error = yield* Effect.flip(Account.use.login("https://one.example.com").pipe(Effect.provide(live(client))))

    expect(error).toBeInstanceOf(AccountTransportError)
    if (error instanceof AccountTransportError) {
      expect(error.method).toBe("GET")
      expect(error.url).toBe("https://one.example.com/api/claxedo/auth/descriptor")
    }
  }),
)

it.live("orgsByAccount groups orgs per account", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-1"),
        userId: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
        binding: nativeBinding(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-2"),
        userId: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
        binding: nativeBinding("https://two.example.com"),
      }),
    )

    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        const discovery = descriptorResponse(req)
        if (discovery) return discovery

        if (req.url === "https://one.example.com/api/claxedo/auth/profile") {
          return json(req, { user: { id: "user-1" }, organizations: [org("org-1", "One")] })
        }

        if (req.url === "https://two.example.com/api/claxedo/auth/profile") {
          return json(req, {
            user: { id: "user-2" },
            organizations: [org("org-2", "Two A"), org("org-3", "Two B")],
          })
        }

        return json(req, [], 404)
      }),
    )

    const rows = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))

    expect(rows.map((row) => [row.account.id, row.orgs.map((org) => org.id)]).map(([id, orgs]) => [id, orgs])).toEqual([
      [AccountID.make("user-1"), [OrgID.make("org-1")]],
      [AccountID.make("user-2"), [OrgID.make("org-2"), OrgID.make("org-3")]],
    ])
    expect(seen.toSorted()).toEqual([
      "GET https://one.example.com/api/claxedo/auth/descriptor",
      "GET https://one.example.com/api/claxedo/auth/profile",
      "GET https://two.example.com/api/claxedo/auth/descriptor",
      "GET https://two.example.com/api/claxedo/auth/profile",
    ])
  }),
)

it.live("token refresh persists the new token", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        userId: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.none(),
        binding: nativeBinding(),
      }),
    )

    const client = HttpClient.make((req) =>
      Effect.sync(() => {
        const discovery = descriptorResponse(req)
        if (discovery) return discovery
        if (req.url === "https://one.example.com/api/auth/oauth2/token") {
          expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded")
          if (req.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${req.body._tag}`)
          expect(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(req.body.body)))).toEqual({
            client_id: "claxedo-cli",
            grant_type: "refresh_token",
            refresh_token: "rt_old",
            resource: "https://one.example.com/control-plane",
          })
          return json(req, {
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 60,
          })
        }
        return json(req, {}, 404)
      }),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(token)).toBeDefined()
    expect(String(Option.getOrThrow(token))).toBe("at_new")

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
    expect(value.token_expiry).toBeGreaterThan(Date.now())
  }),
)

it.live("quarantines an unbound native credential without contacting its stored URL", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = AccountID.make("unbound-user")
    yield* db
      .insert(AccountTable)
      .values({
        id,
        email: "legacy@example.com",
        user_id: "usr_unbound",
        url: "https://untrusted.example.com",
        access_token: AccessToken.make("legacy_access"),
        refresh_token: RefreshToken.make("legacy_refresh"),
        token_expiry: Date.now() + outsideEagerRefreshWindow,
      })
      .run()

    let requests = 0
    const client = HttpClient.make(() => {
      requests += 1
      return Effect.die("unbound credential attempted network access")
    })
    const error = yield* Effect.flip(Account.use.token(id).pipe(Effect.provide(live(client))))
    expect(error).toBeInstanceOf(AccountServiceError)
    expect(String(error.cause)).toContain("unbound or corrupt")
    expect(requests).toBe(0)
  }),
)

it.live("token refreshes before expiry when inside the eager refresh window", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        userId: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() + insideEagerRefreshWindow,
        orgID: Option.none(),
        binding: nativeBinding(),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        const discovery = descriptorResponse(req)
        if (discovery) return discovery

        if (req.url === "https://one.example.com/api/auth/oauth2/token") {
          refreshCalls += 1
          return json(req, {
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 60,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(String(Option.getOrThrow(token))).toBe("at_new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("concurrent config and token requests coalesce token refresh", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        userId: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.some(OrgID.make("org-9")),
        binding: nativeBinding(),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        const discovery = descriptorResponse(req)
        if (discovery) return discovery

        if (req.url === "https://one.example.com/api/auth/oauth2/token") {
          refreshCalls += 1

          if (refreshCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            return json(req, {
              access_token: "at_new",
              refresh_token: "rt_new",
              expires_in: 60,
            })
          }

          return json(
            req,
            {
              error: "invalid_grant",
              error_description: "refresh token already used",
            },
            400,
          )
        }

        if (req.url === "https://one.example.com/api/config") {
          return json(req, { config: { theme: "light", seats: 5 } })
        }

        return json(req, {}, 404)
      }),
    )

    const [cfg, token] = yield* Account.Service.use((s) =>
      Effect.all([s.config(id, OrgID.make("org-9")), s.token(id)], { concurrency: 2 }),
    ).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(cfg)).toEqual({ theme: "light", seats: 5 })
    expect(String(Option.getOrThrow(token))).toBe("at_new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("config sends the selected org header", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        userId: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
        binding: nativeBinding(),
      }),
    )

    const seen: { auth?: string; org?: string } = {}
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        const discovery = descriptorResponse(req)
        if (discovery) return discovery

        if (req.url === "https://one.example.com/api/config") {
          seen.auth = req.headers.authorization
          seen.org = req.headers["x-org-id"]
          return json(req, { config: { theme: "light", seats: 5 } })
        }

        return json(req, {}, 404)
      }),
    )

    const cfg = yield* Account.Service.use((s) => s.config(id, OrgID.make("org-9"))).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(cfg)).toEqual({ theme: "light", seats: 5 })
    expect(seen).toEqual({
      auth: "Bearer at_1",
      org: "org-9",
    })
  }),
)

it.live("poll stores the account and first org on success", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.sync(() => {
        const discovery = descriptorResponse(req)
        if (discovery) return discovery
        if (req.url === "https://one.example.com/api/auth/oauth2/token") {
          expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded")
          if (req.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${req.body._tag}`)
          expect(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(req.body.body)))).toEqual({
            client_id: "claxedo-cli",
            device_code: "device-code",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            resource: "https://one.example.com/control-plane",
          })
          return json(req, {
            access_token: "at_1",
            refresh_token: "rt_1",
            token_type: "Bearer",
            expires_in: 60,
          })
        }
        if (req.url === "https://one.example.com/api/claxedo/auth/profile") {
          return json(req, { user: { id: "user-1" }, organizations: [org("org-1", "One")] })
        }
        return json(req, {}, 404)
      }),
    )

    const res = yield* Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(client)))

    expect(res._tag).toBe("PollSuccess")
    if (res._tag === "PollSuccess") {
      expect(res.userId).toBe("user-1")
    }

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active)).toEqual(
      expect.objectContaining({
        id: "deployment:https://one.example.com:user-1",
        user_id: "user-1",
        active_org_id: "org-1",
      }),
    )
  }),
)

for (const [name, body, expectedTag] of [
  [
    "pending",
    {
      error: "authorization_pending",
      error_description: "The authorization request is still pending",
    },
    "PollPending",
  ],
  [
    "slow",
    {
      error: "slow_down",
      error_description: "Polling too frequently, please slow down",
    },
    "PollSlow",
  ],
  [
    "denied",
    {
      error: "access_denied",
      error_description: "The authorization request was denied",
    },
    "PollDenied",
  ],
  [
    "expired",
    {
      error: "expired_token",
      error_description: "The device code has expired",
    },
    "PollExpired",
  ],
] as const) {
  it.live(`poll returns ${name} for ${body.error}`, () =>
    Effect.gen(function* () {
      const result = yield* poll(body)
      expect(result._tag).toBe(expectedTag)
    }),
  )
}

it.live("poll returns poll error for other OAuth errors", () =>
  Effect.gen(function* () {
    const result = yield* poll({
      error: "server_error",
      error_description: "An unexpected error occurred",
    })

    expect(result._tag).toBe("PollError")
    if (result._tag === "PollError") {
      expect(String(result.cause)).toContain("server_error")
    }
  }),
)

it.live("logout revokes the bound refresh family through RFC 7009 before deleting local credentials", () =>
  Effect.gen(function* () {
    const id = AccountID.make("logout-success")
    yield* AccountRepo.use.persistAccount({
      id,
      userId: "logout-user",
      url: "https://one.example.com",
      accessToken: AccessToken.make("access-secret"),
      refreshToken: RefreshToken.make("refresh-secret"),
      expiry: Date.now() + outsideEagerRefreshWindow,
      orgID: Option.none(),
      binding: nativeBinding(),
    })

    const seen: string[] = []
    const client = HttpClient.make((req) =>
      Effect.sync(() => {
        seen.push(`${req.method} ${req.url}`)
        const discovery = descriptorResponse(req)
        if (discovery) return discovery
        if (req.url === "https://one.example.com/api/auth/oauth2/revoke") {
          expect(req.headers.authorization).toBeUndefined()
          expect(req.headers.cookie).toBeUndefined()
          expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded")
          if (req.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${req.body._tag}`)
          expect(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(req.body.body)))).toEqual({
            client_id: "claxedo-cli",
            token: "refresh-secret",
            token_type_hint: "refresh_token",
          })
          return HttpClientResponse.fromWeb(req, new Response(null, { status: 200 }))
        }
        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use.remove(id).pipe(Effect.provide(live(client)))
    expect(result).toEqual({ remoteRevocation: "revoked" })
    expect(seen).toEqual([
      "GET https://one.example.com/api/claxedo/auth/descriptor",
      "POST https://one.example.com/api/auth/oauth2/revoke",
    ])
    expect(Option.isNone(yield* AccountRepo.use.getRow(id))).toBe(true)
  }),
)

it.live("logout reports network and non-200 revocation as uncertain while always deleting local credentials", () =>
  Effect.gen(function* () {
    for (const failure of ["network", "non-200"] as const) {
      const id = AccountID.make(`logout-${failure}`)
      yield* AccountRepo.use.persistAccount({
        id,
        userId: `logout-${failure}`,
        url: "https://one.example.com",
        accessToken: AccessToken.make(`access-${failure}`),
        refreshToken: RefreshToken.make(`refresh-${failure}`),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
        binding: nativeBinding(),
      })

      const client = HttpClient.make((req) => {
        const discovery = descriptorResponse(req)
        if (discovery) return Effect.succeed(discovery)
        if (failure === "non-200") {
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 503 })))
        }
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req }),
          }),
        )
      })

      const result = yield* Account.use.remove(id).pipe(Effect.provide(live(client)))
      expect(result).toEqual({ remoteRevocation: "uncertain" })
      expect(Option.isNone(yield* AccountRepo.use.getRow(id))).toBe(true)
    }
  }),
)

it.live("logout refuses revocation network when the current descriptor drifts from the stored binding", () =>
  Effect.gen(function* () {
    const id = AccountID.make("logout-drift")
    yield* AccountRepo.use.persistAccount({
      id,
      userId: "logout-drift",
      url: "https://one.example.com",
      accessToken: AccessToken.make("access-drift"),
      refreshToken: RefreshToken.make("refresh-drift"),
      expiry: Date.now() + outsideEagerRefreshWindow,
      orgID: Option.none(),
      binding: nativeBinding(),
    })

    const seen: string[] = []
    const client = HttpClient.make((req) =>
      Effect.sync(() => {
        seen.push(`${req.method} ${req.url}`)
        if (new URL(req.url).pathname === "/api/claxedo/auth/descriptor") {
          return json(req, { ...authDescriptor(), deploymentId: "replacement-deployment" })
        }
        throw new Error("binding drift attempted revocation network")
      }),
    )

    const result = yield* Account.use.remove(id).pipe(Effect.provide(live(client)))
    expect(result).toEqual({ remoteRevocation: "uncertain" })
    expect(seen).toEqual(["GET https://one.example.com/api/claxedo/auth/descriptor"])
    expect(Option.isNone(yield* AccountRepo.use.getRow(id))).toBe(true)
  }),
)

it.live("logout keeps adapter-native revocation as an explicit uncertain peer with no RFC 7009 fallback", () =>
  Effect.gen(function* () {
    const origin = "https://one.example.com"
    const id = AccountID.make("logout-retained")
    yield* AccountRepo.use.persistAccount({
      id,
      userId: "logout-retained",
      url: origin,
      accessToken: AccessToken.make("retained-access"),
      refreshToken: RefreshToken.make("retained-refresh"),
      expiry: Date.now() + outsideEagerRefreshWindow,
      orgID: Option.none(),
      binding: {
        ...nativeBinding(origin),
        adapter: "clerk",
        issuer: `${origin}/clerk`,
      },
    })

    const retainedDescriptor = {
      ...authDescriptor(origin),
      adapter: "clerk",
      issuer: `${origin}/clerk`,
      native: {
        cli: {
          ...authDescriptor(origin).native.cli,
          flow: "adapter-native",
          revocation: {
            protocol: "adapter-native",
            endpoint: `${origin}/clerk/native/revoke`,
          },
        },
      },
    }
    const seen: string[] = []
    const client = HttpClient.make((req) =>
      Effect.sync(() => {
        seen.push(`${req.method} ${req.url}`)
        if (new URL(req.url).pathname === "/api/claxedo/auth/descriptor") return json(req, retainedDescriptor)
        throw new Error("adapter-native dispatch fell back to an HTTP revocation protocol")
      }),
    )

    const result = yield* Account.use.remove(id).pipe(Effect.provide(live(client)))
    expect(result).toEqual({ remoteRevocation: "uncertain" })
    expect(seen).toEqual(["GET https://one.example.com/api/claxedo/auth/descriptor"])
    expect(Option.isNone(yield* AccountRepo.use.getRow(id))).toBe(true)
  }),
)
