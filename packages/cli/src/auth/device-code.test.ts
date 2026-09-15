import { describe, expect, test } from "bun:test"
import { parseCliAuthDescriptor } from "./auth-descriptor"
import { DEVICE_CODE_GRANT, login, type LoginDeps } from "./device-code"
import { refreshCredentials } from "./token-store"
import type { Credentials } from "./token-store"

const ORIGIN = "https://cp.example.test"
const ISSUER = `${ORIGIN}/api/auth`
const RESOURCE = `${ORIGIN}/control-plane`
const SCOPES = ["openid", "profile", "email", "offline_access", "workspace:read", "workspace:write"]

function descriptor(overrides: Record<string, unknown> = {}) {
  const client = (flow: string, clientId: string) => ({
    flow,
    clientId,
    resource: RESOURCE,
    scopes: SCOPES,
    tokenEndpointOrigin: ORIGIN,
    controlPlaneOrigin: ORIGIN,
    revocation: { protocol: "rfc7009", endpoint: `${ISSUER}/oauth2/revoke`, tokenEndpointAuthMethod: "none" },
  })
  return {
    adapter: "better-auth",
    deploymentId: "dep_1",
    configurationVersion: "v1",
    expiresAt: 2_000_000,
    issuer: ISSUER,
    methods: ["email-password"],
    browser: {},
    native: { cli: client("device-authorization", "claxedo-cli"), desktop: client("authorization-code-pkce", "claxedo-desktop") },
    ...overrides,
  }
}

type Outcome = "approved" | "denied" | "expired"

/**
 * Better Auth's device grant as the CLI sees it: `client_id` required at
 * `/device/code`, form-encoded grants at `/oauth2/token` with RFC 6749 error
 * bodies, one `slow_down` for the first poll, userinfo behind the token.
 */
function fakeIssuer(input: { outcome?: Outcome; descriptor?: unknown } = {}) {
  const outcome = input.outcome ?? "approved"
  const calls: Array<{ path: string; body: unknown }> = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  let polls = 0
  const fetch = async (url: URL, init: RequestInit) => {
    if (url.origin !== ORIGIN) return new Response("wrong host", { status: 502 })
    const raw = typeof init.body === "string" ? init.body : ""
    const contentType = new Headers(init.headers).get("content-type") ?? ""
    const body = contentType.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw))
    calls.push({ path: url.pathname, body })
    if (url.pathname === "/api/claxedo/auth/descriptor") return json(input.descriptor ?? descriptor())
    if (url.pathname === "/api/auth/device/code") {
      if (!body.client_id) return json({ error: "invalid_request", error_description: "client_id is required" }, 400)
      if (body.client_id !== "claxedo-cli") return json({ error: "invalid_client" }, 401)
      return json({ device_code: "dev_1", user_code: "ABCD-EFGH", verification_uri: `${ORIGIN}/device`, verification_uri_complete: `${ORIGIN}/device?user_code=ABCD-EFGH`, interval: 1, expires_in: 600 })
    }
    if (url.pathname === "/api/auth/oauth2/token") {
      if (!contentType.includes("application/x-www-form-urlencoded")) return json({ error: "invalid_request" }, 400)
      if (body.grant_type === DEVICE_CODE_GRANT) {
        if (body.device_code !== "dev_1" || body.client_id !== "claxedo-cli") return json({ error: "invalid_grant" }, 400)
        polls += 1
        if (polls === 1) return json({ error: "authorization_pending" }, 400)
        if (polls === 2) return json({ error: "slow_down", error_description: "Polling too frequently" }, 400)
        if (outcome === "denied") return json({ error: "access_denied" }, 400)
        if (outcome === "expired") return json({ error: "expired_token" }, 400)
        return json({ access_token: "at_1", refresh_token: "rt_1", token_type: "Bearer", expires_in: 300, scope: SCOPES.join(" ") })
      }
      if (body.grant_type === "refresh_token") {
        if (body.refresh_token !== "rt_1") return json({ error: "invalid_grant" }, 400)
        return json({ access_token: `at_2_${body.client_id}`, refresh_token: "rt_2", token_type: "Bearer", expires_in: 300 })
      }
      return json({ error: "unsupported_grant_type" }, 400)
    }
    if (url.pathname === "/api/auth/oauth2/userinfo") {
      if (new Headers(init.headers).get("authorization") !== "Bearer at_1") return json({ error: "invalid_token" }, 401)
      return json({ sub: "user_1", email: "owner@example.test" })
    }
    return new Response("not found", { status: 404 })
  }
  return { fetch, calls }
}

function loginDeps(issuer: ReturnType<typeof fakeIssuer>, overrides: Partial<LoginDeps> = {}) {
  const lines: string[] = []
  const opened: string[] = []
  const written: Credentials[] = []
  const slept: number[] = []
  let now = 1_000_000
  const deps: LoginDeps = {
    controlPlaneUrl: ORIGIN,
    fetch: issuer.fetch,
    openBrowser: (target) => { opened.push(target) },
    sleep: async (ms) => { slept.push(ms); now += ms },
    now: () => now,
    log: (line) => { lines.push(line) },
    writeCredentials: async (credentials) => { written.push(credentials) },
    ...overrides,
  }
  return { deps, lines, opened, written, slept }
}

describe("claxedo login", () => {
  test("reads the descriptor, requests a code for its client, waits out pending and slow_down, stores the token set", async () => {
    const issuer = fakeIssuer()
    const h = loginDeps(issuer)
    await login(h.deps)

    expect(issuer.calls.map((call) => call.path)).toEqual([
      "/api/claxedo/auth/descriptor",
      "/api/auth/device/code",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/userinfo",
    ])
    expect(issuer.calls[1]?.body).toEqual({ client_id: "claxedo-cli", scope: SCOPES.join(" "), resource: RESOURCE })
    expect(issuer.calls[2]?.body).toEqual({ grant_type: DEVICE_CODE_GRANT, device_code: "dev_1", client_id: "claxedo-cli", resource: RESOURCE })
    expect(h.slept, "the interval, then +5s after slow_down").toEqual([1000, 1000, 6000])
    expect(h.opened).toEqual([`${ORIGIN}/device?user_code=ABCD-EFGH`])
    expect(h.lines).toEqual([`Open ${ORIGIN}/device?user_code=ABCD-EFGH`, "Enter code: ABCD-EFGH", "Signed in as owner@example.test"])
    expect(h.written).toEqual([
      { controlPlaneUrl: ORIGIN, accessToken: "at_1", refreshToken: "rt_1", tokenType: "Bearer", expiresAt: 1_000_000 + 8000 + 300_000, identity: "owner@example.test" },
    ])
  })

  test("a denial in the browser ends the login; an expired code says to run it again", async () => {
    const denied = loginDeps(fakeIssuer({ outcome: "denied" }))
    await expect(login(denied.deps)).rejects.toThrow("Device login was denied in the browser.")
    expect(denied.written).toEqual([])

    const expired = loginDeps(fakeIssuer({ outcome: "expired" }))
    await expect(login(expired.deps)).rejects.toThrow("Device login expired. Run `claxedo login` again.")
    expect(expired.written).toEqual([])
  })

  test("a control plane without a descriptor names what is missing", async () => {
    const h = loginDeps(fakeIssuer(), {
      fetch: async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers: { "content-type": "application/json" } }),
    })
    await expect(login(h.deps)).rejects.toThrow(`${ORIGIN} serves no auth descriptor`)
    expect(h.opened).toEqual([])
  })
})

describe("parseCliAuthDescriptor", () => {
  test("binds the CLI and desktop clients to the issuer", () => {
    const binding = parseCliAuthDescriptor(descriptor(), ORIGIN, 1_000_000)
    expect(binding).toEqual({
      issuer: ISSUER,
      deviceCodeUrl: `${ISSUER}/device/code`,
      tokenUrl: `${ISSUER}/oauth2/token`,
      userInfoUrl: `${ISSUER}/oauth2/userinfo`,
      cli: { clientId: "claxedo-cli", resource: RESOURCE, scopes: SCOPES },
      desktop: { clientId: "claxedo-desktop", resource: RESOURCE, scopes: SCOPES },
    })
  })

  test("refuses a document for another control plane, another adapter, another flow, or one that has expired", () => {
    const foreign = descriptor()
    foreign.native.cli.controlPlaneOrigin = "https://other.example.test"
    expect(() => parseCliAuthDescriptor(foreign, ORIGIN, 1)).toThrow("belongs to another control plane")
    expect(() => parseCliAuthDescriptor(descriptor({ adapter: "custom" }), ORIGIN, 1)).toThrow("has no CLI login flow")
    expect(() => parseCliAuthDescriptor(descriptor(), ORIGIN, 3_000_000)).toThrow("expired")
    const pkceOnly = descriptor()
    pkceOnly.native.cli.flow = "authorization-code-pkce"
    expect(() => parseCliAuthDescriptor(pkceOnly, ORIGIN, 1)).toThrow("native.cli.flow is authorization-code-pkce")
    const elsewhere = descriptor()
    elsewhere.native.cli.tokenEndpointOrigin = "https://tokens.example.test"
    expect(() => parseCliAuthDescriptor(elsewhere, ORIGIN, 1)).toThrow("does not match the issuer")
  })
})

describe("refreshCredentials", () => {
  const stored: Credentials = { controlPlaneUrl: ORIGIN, accessToken: "at_1", refreshToken: "rt_1", tokenType: "Bearer", expiresAt: 5, identity: "owner@example.test" }

  test("refreshes as the CLI client at the issuer's token endpoint", async () => {
    const issuer = fakeIssuer()
    const refreshed = await refreshCredentials(stored, { fetch: issuer.fetch, now: () => 7_000 })
    expect(issuer.calls.at(-1)).toEqual({
      path: "/api/auth/oauth2/token",
      body: { grant_type: "refresh_token", refresh_token: "rt_1", client_id: "claxedo-cli", resource: RESOURCE },
    })
    expect(refreshed).toEqual({ controlPlaneUrl: ORIGIN, accessToken: "at_2_claxedo-cli", refreshToken: "rt_2", tokenType: "Bearer", expiresAt: 307_000, identity: "owner@example.test" })
  })

  test("a credential the desktop mirrored refreshes as the desktop client", async () => {
    const issuer = fakeIssuer()
    const refreshed = await refreshCredentials({ ...stored, identity: "claxedo-desktop" }, { fetch: issuer.fetch, now: () => 0 })
    expect(issuer.calls.at(-1)?.body).toMatchObject({ client_id: "claxedo-desktop" })
    expect(refreshed.accessToken).toBe("at_2_claxedo-desktop")
  })

  test("without a refresh token the user signs in again", async () => {
    const issuer = fakeIssuer()
    await expect(refreshCredentials({ controlPlaneUrl: ORIGIN, accessToken: "at_1" }, { fetch: issuer.fetch, now: () => 0 })).rejects.toThrow("Run `claxedo login` again")
    expect(issuer.calls).toEqual([])
  })
})
