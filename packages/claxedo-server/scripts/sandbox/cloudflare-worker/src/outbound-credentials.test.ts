import { expect, test, vi } from "vitest"
import { credentialPlaceholder, forwardCredential, parseRegistrations } from "./outbound-credentials"

const registration = {
  name: "KEY",
  hosts: ["api.vendor.test"],
  header: "Authorization",
  value: "Bearer first-secret",
  methods: ["GET", "POST"],
  pathPrefixes: ["/v1"],
}
const request = (authorization = `Bearer ${credentialPlaceholder("KEY")}`, url = "https://api.vendor.test/v1/messages") => new Request(url, { headers: { Authorization: authorization, Cookie: "session=private" } })

test("reads authority on every request so rotation and withdrawal affect existing placeholders", async () => {
  let rows = [registration]
  const upstream = vi.fn(async (input: Request) => {
    expect(input.headers.has("cookie")).toBe(false)
    expect(input.redirect).toBe("manual")
    return new Response(input.headers.get("Authorization"))
  })
  const options = { registrations: async () => rows, fetch: upstream }
  expect(await (await forwardCredential(request(), options)).text()).toBe("Bearer first-secret")
  rows = [{ ...registration, value: "Bearer rotated-secret" }]
  expect(await (await forwardCredential(request(), options)).text()).toBe("Bearer rotated-secret")
  rows = []
  expect((await forwardCredential(request(), options)).status).toBe(403)
  expect(upstream).toHaveBeenCalledTimes(2)
})

test("same-host credentials are selected by their named placeholder", async () => {
  const upstream = vi.fn(async (input: Request) => new Response(input.headers.get("Authorization")))
  const options = { registrations: async () => [registration, { ...registration, name: "OTHER", value: "Bearer other-secret" }], fetch: upstream }
  expect(await (await forwardCredential(request(credentialPlaceholder("OTHER")), options)).text()).toBe("Bearer other-secret")
  for (const input of [request(undefined, "https://elsewhere.test/"), request(undefined, "http://api.vendor.test/")]) {
    expect((await forwardCredential(input, options)).status).toBe(403)
  }
  expect(upstream).toHaveBeenCalledTimes(1)
})

test("a request to a registered host carrying no placeholder is forwarded untouched", async () => {
  // `git clone`, `npm i github:…` and `curl` all reach a host the moment a
  // token for it is registered. Answering 403 to everything that is not our
  // placeholder broke every one of them inside a hosted sandbox.
  const upstream = vi.fn(async (input: Request) => new Response(input.headers.get("Authorization") ?? "none"))
  const options = { registrations: async () => [registration], fetch: upstream }

  for (const input of [
    request("Bearer somebody-elses-token"),
    new Request("https://api.vendor.test/v1/models"),
    new Request("http://api.vendor.test/plain"),
  ]) {
    const response = await forwardCredential(input, options)
    expect(response.status).toBe(200)
  }
  expect(upstream).toHaveBeenCalledTimes(3)
  expect(upstream.mock.calls[0][0].headers.get("Authorization")).toBe("Bearer somebody-elses-token")
  expect(upstream.mock.calls[0][0].headers.get("Cookie")).toBe("session=private")
})

test("a placeholder that matches no registration is still refused", async () => {
  const upstream = vi.fn(async () => new Response("forwarded"))
  const options = { registrations: async () => [registration], fetch: upstream }

  expect((await forwardCredential(request(credentialPlaceholder("WITHDRAWN")), options)).status).toBe(403)
  expect(upstream).not.toHaveBeenCalled()
})

test("redirects cannot carry credentials to another destination", async () => {
  const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }))
  const response = await forwardCredential(request(), { registrations: async () => [registration], fetch: upstream })
  expect(response.status).toBe(502)
  expect(response.headers.has("location")).toBe(false)
  expect(upstream).toHaveBeenCalledTimes(1)
})

test("authority failures are unavailable and never forward", async () => {
  const upstream = vi.fn()
  expect((await forwardCredential(request(), { registrations: async () => { throw Error("KV unavailable") }, fetch: upstream })).status).toBe(503)
  expect(upstream).not.toHaveBeenCalled()
})

test("strips credential and cookie response headers without eating the rest", async () => {
  const response = await forwardCredential(request(), { registrations: async () => [registration], fetch: (async () => new Response("ok", { headers: { Authorization: "Bearer first-secret", "Set-Cookie": "secret", "x-api-key": "secret", "content-type": "text/plain" } })) })
  for (const name of ["authorization", "set-cookie", "x-api-key"]) expect(response.headers.has(name)).toBe(false)
  // Scrubbing is a named list, not a reset: a client that cannot read
  // content-type cannot parse what it was sent.
  expect(response.headers.get("content-type")).toBe("text/plain")
  expect(await response.text()).toBe("ok")
})

test("the upstream request keeps the original url the client asked for", async () => {
  // Native brokering substitutes a header, never the destination: a rewritten
  // path or host would send the credential somewhere the binding never allowed.
  const forwarded: string[] = []
  const upstream = vi.fn(async (input: Request) => {
    forwarded.push(input.url)
    return new Response("ok")
  })
  await forwardCredential(request(undefined, "https://api.vendor.test/v1/users/me?page=2"), {
    registrations: async () => [registration],
    fetch: upstream,
  })
  expect(forwarded).toEqual(["https://api.vendor.test/v1/users/me?page=2"])
})

test("registration validation rejects malformed and ambiguous input", () => {
  expect(parseRegistrations([registration])).toEqual([registration])
  for (const rows of [
    null,
    {},
    [registration, registration],
    [{ ...registration, hosts: ["*.vendor.test"] }],
    [{ ...registration, header: "Host" }],
    [{ ...registration, value: "bad\r\nheader" }],
    [{ ...registration, methods: ["post"] }],
    [{ ...registration, methods: "POST" }],
    [{ ...registration, pathPrefixes: ["v1/messages"] }],
  ]) {
    expect(() => parseRegistrations(rows)).toThrow()
  }
})

test("the credential rides only the routes the destination allows", async () => {
  const upstream = vi.fn(async (input: Request) => new Response(input.headers.get("Authorization")))
  const rows = [{ ...registration, pathPrefixes: ["/v1/messages"], methods: ["POST"] }]
  const options = { registrations: async () => rows, fetch: upstream }

  const allowed = await forwardCredential(
    new Request("https://api.vendor.test/v1/messages", { method: "POST", headers: { Authorization: `Bearer ${credentialPlaceholder("KEY")}` } }),
    options,
  )
  expect(allowed.status).toBe(200)
  expect(await allowed.text()).toBe("Bearer first-secret")

  for (const outside of [
    new Request("https://api.vendor.test/v1/organizations", { method: "POST", headers: { Authorization: `Bearer ${credentialPlaceholder("KEY")}` } }),
    new Request("https://api.vendor.test/v1/messages-other", { method: "POST", headers: { Authorization: `Bearer ${credentialPlaceholder("KEY")}` } }),
    new Request("https://api.vendor.test/v1/messages/%2e%2e/organizations", { method: "POST", headers: { Authorization: `Bearer ${credentialPlaceholder("KEY")}` } }),
    new Request("https://api.vendor.test/v1/messages", { method: "GET", headers: { Authorization: `Bearer ${credentialPlaceholder("KEY")}` } }),
  ]) {
    expect((await forwardCredential(outside, options)).status).toBe(403)
  }
  expect(upstream).toHaveBeenCalledTimes(1)
})

test("a registration that states no route policy spends the credential nowhere", async () => {
  // A producer that predates the policy still provisions its sandbox — the
  // parse accepts it — and is refused at every request instead of forwarding
  // the operator's key to whatever route a sandbox process happens to name.
  const upstream = vi.fn(async () => new Response("forwarded"))
  const { methods, pathPrefixes, ...stale } = registration
  const parsed = parseRegistrations([stale])
  expect(parsed[0]).toMatchObject({ methods: [], pathPrefixes: [] })

  expect((await forwardCredential(request(), { registrations: async () => parsed, fetch: upstream })).status).toBe(403)
  expect(upstream).not.toHaveBeenCalled()
})
