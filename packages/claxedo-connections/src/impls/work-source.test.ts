import { describe, expect, test } from "bun:test"
import { githubIntegration } from "./github.js"
import { atlassianIntegration } from "./atlassian.js"
import { linearIntegration } from "./linear.js"
import { capabilitiesOf } from "../ports/index.js"

/** The absolute URL a fetch call targeted, for whichever RequestInfo shape it used. */
const requestUrl = (input: string | URL | Request): string => (input instanceof Request ? input.url : input.toString())

/** The header names exactly as the impl set them — `Headers` would lower-case them. */
const headerRecord = (init: HeadersInit | undefined): Record<string, string> => {
  if (!init) return {}
  if (init instanceof Headers) return Object.fromEntries(init.entries())
  if (Array.isArray(init)) return Object.fromEntries(init.map(([name, value]) => [name ?? "", value ?? ""]))
  return { ...init }
}

describe("first-party work-source integrations", () => {
  test("serve only their applicable capabilities", () => {
    // Read off the ports, which is where the capability set now comes from: an
    // integration cannot claim a name that nothing behind it serves.
    expect(capabilitiesOf(githubIntegration().impl.actions)).toEqual(["code-host", "work-source"])
    expect(capabilitiesOf(atlassianIntegration().impl.actions)).toEqual(["docs", "work-source"])
    expect(capabilitiesOf(linearIntegration().impl.actions)).toEqual(["work-source"])
  })

  test("verifies Linear without retaining or returning its key", async () => {
    const seen: string[] = []
    const integration = linearIntegration({
      fetchImpl: (async (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "")
        return Response.json({ data: { viewer: { name: "Alice" } } })
      }),
    })
    expect(await integration.impl.auth!.verify!({}, "linear-secret")).toEqual({ ok: true, accountLabel: "Alice" })
    expect(seen).toEqual(["Bearer linear-secret"])
  })

  test("verifies GitHub through /user and returns the login as the account label", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const integration = githubIntegration({
      fetchImpl: (async (input, init) => {
        calls.push({ url: requestUrl(input), headers: headerRecord(init?.headers) })
        return Response.json({ login: "octocat" })
      }),
    })
    const result = await integration.impl.auth!.verify!({}, "github-secret")
    expect(result).toEqual({ ok: true, accountLabel: "octocat" })
    expect(calls[0]?.url).toBe("https://api.github.com/user")
    expect(calls[0]?.headers.Authorization).toBe("Bearer github-secret")
    expect(JSON.stringify(result)).not.toContain("github-secret")
  })

  for (const status of [401, 403] as const) {
    test(`GitHub verify maps ${status} to the closed unauthorized reason`, async () => {
      const integration = githubIntegration({
        fetchImpl: (async (_input: string | URL | Request) => new Response("Bad credentials: github-secret", { status })),
      })
      const result = await integration.impl.auth!.verify!({}, "github-secret")
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(JSON.stringify(result)).not.toContain("github-secret")
    })
  }

  test("GitHub verify reports reason 'network' for transport throws and non-auth error statuses", async () => {
    const thrown = githubIntegration({
      fetchImpl: (async (_input: string | URL | Request) => {
        throw new Error("socket hang up carrying github-secret")
      }),
    })
    const thrownResult = await thrown.impl.auth!.verify!({}, "github-secret")
    expect(thrownResult).toEqual({ ok: false, reason: "network" })
    expect(JSON.stringify(thrownResult)).not.toContain("github-secret")

    const errored = githubIntegration({
      fetchImpl: (async (_input: string | URL | Request) => new Response("upstream boom github-secret", { status: 502 })),
    })
    const erroredResult = await errored.impl.auth!.verify!({}, "github-secret")
    expect(erroredResult).toEqual({ ok: false, reason: "network" })
    expect(JSON.stringify(erroredResult)).not.toContain("github-secret")
  })

  test("Linear verify reports reason 'network' for transport throws and non-auth error statuses", async () => {
    const thrown = linearIntegration({
      fetchImpl: (async (_input: string | URL | Request) => {
        throw new Error("connect ECONNREFUSED while sending linear-secret")
      }),
    })
    const thrownResult = await thrown.impl.auth!.verify!({}, "linear-secret")
    expect(thrownResult).toEqual({ ok: false, reason: "network" })
    expect(JSON.stringify(thrownResult)).not.toContain("linear-secret")

    const errored = linearIntegration({
      fetchImpl: (async (_input: string | URL | Request) => new Response("upstream boom linear-secret", { status: 500 })),
    })
    const erroredResult = await errored.impl.auth!.verify!({}, "linear-secret")
    expect(erroredResult).toEqual({ ok: false, reason: "network" })
    expect(JSON.stringify(erroredResult)).not.toContain("linear-secret")
  })

  test("Linear maps GraphQL-level errors to unauthorized rather than leaking the payload", async () => {
    const integration = linearIntegration({
      fetchImpl: (async (_input: string | URL | Request) => Response.json({ errors: [{ message: "authentication failed for linear-secret" }] })),
    })
    const result = await integration.impl.auth!.verify!({}, "linear-secret")
    expect(result).toEqual({ ok: false, reason: "unauthorized" })
    expect(JSON.stringify(result)).not.toContain("linear-secret")
  })
})
