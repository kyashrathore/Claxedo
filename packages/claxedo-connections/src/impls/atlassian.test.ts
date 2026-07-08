import { describe, expect, test } from "bun:test"
import { atlassianIntegration, normalizeSiteUrl } from "./atlassian.js"

describe("atlassian site allowlist", () => {
  test("accepts only https://<site>.atlassian.net origins", () => {
    expect(normalizeSiteUrl("https://acme.atlassian.net")).toBe("https://acme.atlassian.net")
    expect(normalizeSiteUrl("  https://acme.atlassian.net/wiki/home  ")).toBe("https://acme.atlassian.net")
    expect(normalizeSiteUrl("https://my-team2.atlassian.net")).toBe("https://my-team2.atlassian.net")
  })

  test("rejects non-Atlassian and lookalike hosts (token-exfiltration guard)", () => {
    expect(normalizeSiteUrl("https://acme.example")).toBeUndefined()
    expect(normalizeSiteUrl("https://evil-atlassian.net")).toBeUndefined()
    expect(normalizeSiteUrl("https://atlassian.net.evil.com")).toBeUndefined()
    expect(normalizeSiteUrl("https://acme.atlassian.net.evil.com")).toBeUndefined()
    expect(normalizeSiteUrl("https://atlassian.net")).toBeUndefined()
    expect(normalizeSiteUrl("https://sub.acme.atlassian.net")).toBeUndefined()
  })

  test("rejects non-https, explicit ports, and garbage", () => {
    expect(normalizeSiteUrl("http://acme.atlassian.net")).toBeUndefined()
    expect(normalizeSiteUrl("https://acme.atlassian.net:8443")).toBeUndefined()
    expect(normalizeSiteUrl("not a url")).toBeUndefined()
    expect(normalizeSiteUrl("")).toBeUndefined()
  })

  test("verify() never sends credentials to a disallowed host", async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input))
      return Response.json({ displayName: "who" })
    }) as typeof fetch
    const { impl } = atlassianIntegration({ fetchImpl })
    const denied = await impl.verify!({ site_url: "https://evil.example", email: "a@b.c" }, "tok")
    expect(denied).toEqual({ ok: false, reason: "unauthorized" })
    expect(seen).toHaveLength(0)

    const allowed = await impl.verify!({ site_url: "https://acme.atlassian.net", email: "a@b.c" }, "tok")
    expect(allowed).toMatchObject({ ok: true })
    expect(seen).toEqual(["https://acme.atlassian.net/wiki/rest/api/user/current"])
  })
})
