import { describe, expect, test } from "vitest"
import { verifySandboxDriverCredential } from "./sandbox-verify"

/**
 * `fetch` as workerd implements it: a redirect mode other than "follow" or
 * "manual" is a TypeError before any request leaves, so a probe written for
 * Node's "error" mode never reaches the provider from the hosted Worker.
 */
function workerdFetch(answer: () => Response) {
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined; authorization: string | null }> = []
  const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.redirect !== undefined && init.redirect !== "follow" && init.redirect !== "manual") {
      throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" ("${init.redirect}" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).`)
    }
    calls.push({ url: input instanceof Request ? input.url : input.toString(), redirect: init?.redirect, authorization: new Headers(init?.headers).get("authorization") })
    return answer()
  }, { preconnect() {} }) as typeof fetch
  return { calls, fetchImpl }
}

const boatKey = JSON.stringify({ api_key: " boat_key " })

describe("the Boat key probe under workerd", () => {
  test("asks Boat for the current user with the key as a bearer and reads an answer as a verdict", async () => {
    const { calls, fetchImpl } = workerdFetch(() => Response.json({ ok: true, type: "user.info" }))
    await expect(verifySandboxDriverCredential("boat", boatKey, { fetch: fetchImpl })).resolves.toBe("ok")
    expect(calls).toEqual([{ url: "https://boat.dev/api/v1/me", redirect: "manual", authorization: "Bearer boat_key" }])
    const refused = workerdFetch(() => Response.json({ ok: false, code: "unauthorized" }, { status: 401 }))
    await expect(verifySandboxDriverCredential("boat", boatKey, { fetch: refused.fetchImpl })).resolves.toBe("auth_failed")
  })

  test("a redirect is refused as a verdict of its own rather than followed or reported as an unreachable provider", async () => {
    const { fetchImpl } = workerdFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/me" } }))
    await expect(verifySandboxDriverCredential("boat", boatKey, { fetch: fetchImpl })).rejects.toMatchObject({ code: "credential_redirect_denied" })
  })
})
