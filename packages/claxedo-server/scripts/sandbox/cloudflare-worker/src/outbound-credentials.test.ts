import { expect, test, vi } from "vitest"
import { credentialPlaceholder, forwardCredential, parseRegistrations } from "./outbound-credentials"

const registration = { name: "KEY", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer first-secret" }
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
  for (const input of [request("Bearer unknown"), request(undefined, "https://elsewhere.test/"), request(undefined, "http://api.vendor.test/")]) {
    expect((await forwardCredential(input, options)).status).toBe(403)
  }
  expect(upstream).toHaveBeenCalledTimes(1)
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

test("strips credential and cookie response headers", async () => {
  const response = await forwardCredential(request(), { registrations: async () => [registration], fetch: (async () => new Response("ok", { headers: { Authorization: "Bearer first-secret", "Set-Cookie": "secret", "x-api-key": "secret" } })) })
  for (const name of ["authorization", "set-cookie", "x-api-key"]) expect(response.headers.has(name)).toBe(false)
  expect(await response.text()).toBe("ok")
})

test("registration validation rejects malformed and ambiguous input", () => {
  expect(parseRegistrations([registration])).toEqual([registration])
  for (const rows of [null, {}, [registration, registration], [{ ...registration, hosts: ["*.vendor.test"] }], [{ ...registration, header: "Host" }], [{ ...registration, value: "bad\r\nheader" }]]) {
    expect(() => parseRegistrations(rows)).toThrow()
  }
})
