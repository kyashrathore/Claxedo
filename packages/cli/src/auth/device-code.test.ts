import { describe, expect, test } from "bun:test"
import { deploymentPageUrl, parseCliAuthDescriptor } from "./auth-descriptor"
import { DEVICE_CODE_GRANT, login, type LoginDeps } from "./device-code"
import { refreshCredentials } from "./token-store"
import type { Credentials } from "./token-store"

const ORIGIN = "https://cp.example.test"
const ISSUER = `${ORIGIN}/api/auth`
const RESOURCE = `${ORIGIN}/control-plane`
const SCOPES = ["openid", "profile", "email", "offline_access", "workspace:read", "workspace:write"]

function descriptor(overrides: Record<string, unknown> = {}, origin = ORIGIN) {
  const issuer = `${origin}/api/auth`
  const resource = `${origin}/control-plane`
  const client = (flow: string, clientId: string) => ({
    flow,
    clientId,
    resource,
    scopes: SCOPES,
    tokenEndpointOrigin: origin,
    controlPlaneOrigin: origin,
    revocation: { protocol: "rfc7009", endpoint: `${issuer}/oauth2/revoke`, tokenEndpointAuthMethod: "none" },
  })
  return {
    adapter: "better-auth",
    deploymentId: "dep_1",
    configurationVersion: "v1",
    expiresAt: 2_000_000,
    issuer,
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
function fakeIssuer(
  input: { outcome?: Outcome; descriptor?: unknown; device?: Record<string, unknown>; origin?: string; redirectTo?: { path: string; location: string } } = {},
) {
  const outcome = input.outcome ?? "approved"
  const origin = input.origin ?? ORIGIN
  const calls: Array<{ path: string; body: unknown }> = []
  /** Every URL the CLI reached for, recorded before any host check, so a downgraded request is visible. */
  const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  let polls = 0
  const fetch = async (url: URL, init: RequestInit) => {
    requests.push({ url: url.toString(), redirect: init.redirect })
    if (url.origin !== origin) return new Response("wrong host", { status: 502 })
    if (input.redirectTo && url.pathname === input.redirectTo.path) {
      return new Response(null, { status: 302, headers: { location: input.redirectTo.location } })
    }
    const raw = typeof init.body === "string" ? init.body : ""
    const contentType = new Headers(init.headers).get("content-type") ?? ""
    const body = contentType.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw))
    calls.push({ path: url.pathname, body })
    if (url.pathname === "/api/claxedo/auth/descriptor") return json(input.descriptor ?? descriptor({}, origin))
    if (url.pathname === "/api/auth/device/code") {
      if (!body.client_id) return json({ error: "invalid_request", error_description: "client_id is required" }, 400)
      if (body.client_id !== "claxedo-cli") return json({ error: "invalid_client" }, 401)
      return json({ device_code: "dev_1", user_code: "ABCD-EFGH", verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?user_code=ABCD-EFGH`, interval: 1, expires_in: 600, ...input.device })
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
  return { fetch, calls, requests }
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

  test("a verification URL on another origin ends the login before anything is opened or printed", async () => {
    const h = loginDeps(fakeIssuer({ device: { verification_uri_complete: "https://evil.example.test/device?user_code=ABCD-EFGH" } }))
    await expect(login(h.deps)).rejects.toThrow("verification_uri_complete points at https://evil.example.test")
    expect(h.opened).toEqual([])
    expect(h.lines).toEqual([])
    expect(h.written).toEqual([])
  })

  test("a verification URL that is not a web page ends the login", async () => {
    const script = loginDeps(fakeIssuer({ device: { verification_uri_complete: "javascript:alert(1)" } }))
    await expect(login(script.deps)).rejects.toThrow("verification_uri_complete is a javascript: URL, not a web page")
    expect(script.opened).toEqual([])

    const file = loginDeps(fakeIssuer({ device: { verification_uri: "file:///Applications/Calculator.app", verification_uri_complete: undefined } }))
    await expect(login(file.deps)).rejects.toThrow("verification_uri is a file: URL, not a web page")
    expect(file.opened).toEqual([])
  })

  test("the web app origin the descriptor trusts is a device page, and its query reaches the browser unchanged", async () => {
    const appOrigin = "https://app.example.test"
    const complete = `${appOrigin}/device?user_code=ABCD-EFGH&next=%26whoami`
    const h = loginDeps(
      fakeIssuer({
        descriptor: descriptor({ browser: { trustedOrigins: [appOrigin], clientId: "claxedo-web", resource: RESOURCE, scopes: SCOPES } }),
        device: { verification_uri: `${appOrigin}/device`, verification_uri_complete: complete },
      }),
    )
    await login(h.deps)
    expect(h.opened).toEqual([complete])
    expect(h.written).toHaveLength(1)
  })
})

describe("parseCliAuthDescriptor", () => {
  test("binds the CLI and desktop clients to the issuer", () => {
    const binding = parseCliAuthDescriptor(descriptor(), ORIGIN, 1_000_000)
    expect(binding).toEqual({
      issuer: ISSUER,
      pageOrigins: [ORIGIN],
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

  test("the pages a device login may open are the control plane, the issuer and the web app origins the document names", () => {
    const split = descriptor({ browser: { trustedOrigins: ["https://app.example.test/", "not a url", 7] } })
    split.issuer = "https://auth.example.test/api/auth"
    split.native.cli.tokenEndpointOrigin = "https://auth.example.test"
    split.native.desktop.tokenEndpointOrigin = "https://auth.example.test"

    const binding = parseCliAuthDescriptor(split, ORIGIN, 1)
    expect(binding.pageOrigins, "malformed trusted origins are dropped, never admitted").toEqual([
      ORIGIN,
      "https://auth.example.test",
      "https://app.example.test",
    ])
    expect(deploymentPageUrl(binding, "https://app.example.test/device?user_code=A&b=c", "verification_uri")).toBe(
      "https://app.example.test/device?user_code=A&b=c",
    )
    expect(() => deploymentPageUrl(binding, "https://app.example.test.evil.test/device", "verification_uri")).toThrow(
      "which this control plane does not serve",
    )
    expect(() => deploymentPageUrl(binding, "/device?user_code=A", "verification_uri")).toThrow("is not a URL")
  })
})

const CLEARTEXT = "must be https:// (http:// only for localhost, 127.0.0.1 or ::1)"

describe("the transport a descriptor may name", () => {
  test("a cleartext issuer is refused, and nothing is fetched, opened, printed or stored after the descriptor", async () => {
    const clear = descriptor()
    clear.issuer = "http://clear.example/api/auth"
    clear.native.cli.tokenEndpointOrigin = "http://clear.example"
    clear.native.desktop.tokenEndpointOrigin = "http://clear.example"
    const issuer = fakeIssuer({ descriptor: clear })
    const h = loginDeps(issuer)

    await expect(login(h.deps)).rejects.toThrow(`Auth descriptor: issuer ${CLEARTEXT}`)

    expect(issuer.requests.map((request) => request.url)).toEqual([`${ORIGIN}/api/claxedo/auth/descriptor`])
    expect(h.opened).toEqual([])
    expect(h.lines).toEqual([])
    expect(h.written).toEqual([])
  })

  test("a cleartext token endpoint, control plane, resource or descriptor-carried userinfo is refused by name", () => {
    const tokens = descriptor()
    tokens.native.cli.tokenEndpointOrigin = "http://clear.example"
    expect(() => parseCliAuthDescriptor(tokens, ORIGIN, 1)).toThrow(`native.cli.tokenEndpointOrigin ${CLEARTEXT}`)

    const plane = descriptor()
    plane.native.cli.controlPlaneOrigin = "http://cp.example.test"
    expect(() => parseCliAuthDescriptor(plane, ORIGIN, 1)).toThrow(`native.cli.controlPlaneOrigin ${CLEARTEXT}`)

    const resource = descriptor()
    resource.native.cli.resource = "http://cp.example.test/control-plane"
    expect(() => parseCliAuthDescriptor(resource, ORIGIN, 1)).toThrow(`native.cli.resource ${CLEARTEXT}`)

    const userinfo = descriptor()
    userinfo.issuer = `https://attacker.example@cp.example.test/api/auth`
    expect(() => parseCliAuthDescriptor(userinfo, ORIGIN, 1)).toThrow("issuer carries a user or password")

    const scheme = descriptor()
    scheme.issuer = "file:///etc/passwd"
    expect(() => parseCliAuthDescriptor(scheme, ORIGIN, 1)).toThrow(`issuer ${CLEARTEXT}`)

    expect(() => parseCliAuthDescriptor(descriptor(), "http://cp.example.test", 1)).toThrow(`control plane URL ${CLEARTEXT}`)
  })

  test("an issuer carrying a query or fragment is refused: the endpoints below it would not mean what they read", () => {
    const query = descriptor()
    query.issuer = `${ORIGIN}/api/auth?next=`
    expect(() => parseCliAuthDescriptor(query, ORIGIN, 1)).toThrow("issuer must be an origin with a plain path")
  })

  test("a cleartext trusted origin never becomes a browser destination", () => {
    const mixed = descriptor({ browser: { trustedOrigins: ["http://app.example.test", "https://app.example.test"] } })
    const binding = parseCliAuthDescriptor(mixed, ORIGIN, 1)

    expect(binding.pageOrigins).toEqual([ORIGIN, "https://app.example.test"])
    expect(() => deploymentPageUrl(binding, "http://app.example.test/device", "verification_uri")).toThrow(
      "which this control plane does not serve",
    )
  })

  test("a verification URL carrying userinfo is refused before the browser sees it", async () => {
    const h = loginDeps(fakeIssuer({ device: { verification_uri_complete: `https://evil.example.test@cp.example.test/device` } }))
    await expect(login(h.deps)).rejects.toThrow("verification_uri_complete carries a user or password")
    expect(h.opened).toEqual([])
  })

  test("a loopback control plane over http signs in: the local development flow is the one cleartext case", async () => {
    const local = "http://127.0.0.1:2593"
    const issuer = fakeIssuer({ origin: local })
    const h = loginDeps(issuer, { controlPlaneUrl: local })

    await login(h.deps)

    expect(h.opened).toEqual([`${local}/device?user_code=ABCD-EFGH`])
    expect(h.written).toHaveLength(1)
    expect(h.written[0]?.accessToken).toBe("at_1")
  })

  test("every auth request refuses to follow a redirect rather than carry the grant to wherever it points", async () => {
    const issuer = fakeIssuer({ redirectTo: { path: "/api/auth/device/code", location: "http://clear.example/device/code" } })
    const h = loginDeps(issuer)

    await expect(login(h.deps)).rejects.toThrow(`POST ${ISSUER}/device/code was redirected to http://clear.example/device/code`)

    expect(issuer.requests.map((request) => request.redirect), "the global fetch is never allowed to follow one either").toEqual([
      "manual",
      "manual",
    ])
    expect(h.opened).toEqual([])
    expect(h.written).toEqual([])
  })

  test("a token endpoint that redirects never receives the device code twice", async () => {
    const issuer = fakeIssuer({ redirectTo: { path: "/api/auth/oauth2/token", location: "http://clear.example/token" } })
    const h = loginDeps(issuer)

    await expect(login(h.deps)).rejects.toThrow(`POST ${ISSUER}/oauth2/token was redirected to http://clear.example/token`)
    expect(issuer.requests.at(-1)?.redirect).toBe("manual")
    expect(h.written).toEqual([])
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
