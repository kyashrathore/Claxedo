import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "../registry.js"
import { createConnectionsService } from "../service.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "../stores/memory.js"
import { ATLASSIAN_SITE_URL_VECTORS } from "./atlassian-site-url-vectors.js"
import { atlassianIntegration, normalizeSiteUrl } from "./atlassian.js"

describe("atlassian site allowlist", () => {
  // The shared vectors are the contract: any request-time consumer iterates
  // this same array so the connect-time and request-time rules cannot drift
  // apart. Keep the hand-written cases below too — they document intent in a
  // way a table does not.
  test.each(ATLASSIAN_SITE_URL_VECTORS.map((vector) => [vector.input, vector.expected, vector.reason] as const))(
    "normalizes %j to %j (%s)",
    (input, expected) => {
      expect(normalizeSiteUrl(input)).toBe(expected)
    },
  )

  test("accepts only https://<site>.atlassian.net origins", () => {
    expect(normalizeSiteUrl("https://acme.atlassian.net")).toBe("https://acme.atlassian.net")
    expect(normalizeSiteUrl("  https://acme.atlassian.net/wiki/home  ")).toBe("https://acme.atlassian.net")
    expect(normalizeSiteUrl("https://my-team2.atlassian.net")).toBe("https://my-team2.atlassian.net")
  })

  // `url.origin` would silently discard all three, so an accepted input would
  // authenticate against a different place than the operator typed.
  test("refuses embedded credentials, a query, or a fragment rather than dropping them", () => {
    expect(normalizeSiteUrl("https://attacker:pw@acme.atlassian.net")).toBeUndefined()
    expect(normalizeSiteUrl("https://acme.atlassian.net?next=https://evil.example")).toBeUndefined()
    expect(normalizeSiteUrl("https://acme.atlassian.net#/wiki")).toBeUndefined()
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
    })
    const { impl } = atlassianIntegration({ fetchImpl })
    const denied = await impl.verify!({ site_url: "https://evil.example", email: "a@b.c" }, "tok")
    expect(denied).toEqual({ ok: false, reason: "unauthorized" })
    expect(seen).toHaveLength(0)

    const allowed = await impl.verify!({ site_url: "https://acme.atlassian.net", email: "a@b.c" }, "tok")
    expect(allowed).toMatchObject({ ok: true })
    expect(seen).toEqual(["https://acme.atlassian.net/wiki/rest/api/user/current"])
  })

  test("verify() reports the normalized origin it authenticated against", async () => {
    const { impl } = atlassianIntegration({
      fetchImpl: (async () => Response.json({ displayName: "Acme Admin" })),
    })
    const result = await impl.verify!(
      { site_url: "  https://acme.atlassian.net/wiki/home/  ", email: "a@b.c" },
      "tok",
    )
    expect(result).toEqual({
      ok: true,
      accountLabel: "Acme Admin",
      fields: { site_url: "https://acme.atlassian.net" },
    })
  })
})

// The strict rule has to survive as STORED state, not just as a check that ran
// once: every later consumer reads the row, and one of them re-derived the rule
// more weakly than connect did.
describe("atlassian connect persists the validated origin", () => {
  function hostedAtlassian() {
    const reference = atlassianIntegration({
      fetchImpl: (async () => Response.json({ displayName: "Acme Admin" })),
    })
    const registry = createIntegrationRegistry()
    registry.register(reference.decl, reference.impl)
    const connections = createMemoryConnectionStore()
    const service = createConnectionsService({
      registry,
      credentials: createMemoryCredentialStore(),
      connections,
      newId: () => "connection-1",
    })
    return { service, connections }
  }

  test("a raw pasted site_url is stored as its canonical origin", async () => {
    const { service, connections } = hostedAtlassian()

    await expect(service.connect({
      integrationId: "atlassian",
      fields: { site_url: "  https://acme.atlassian.net/wiki/home/  ", email: "a@b.c" },
      secret: "tok",
    })).resolves.toEqual({ ok: true })

    const row = await connections.getById("connection-1")
    expect(row?.fields.site_url).toBe("https://acme.atlassian.net")
    // The other declared non-secret field is untouched by canonicalization.
    expect(row?.fields.email).toBe("a@b.c")
    // And the summary the host serves carries the canonical value too.
    const [summary] = await service.list()
    expect(summary?.fields?.site_url).toBe("https://acme.atlassian.net")
  })

  test("reverify repairs a row stored before the impl returned canonical fields", async () => {
    const { service, connections } = hostedAtlassian()
    await service.connect({
      integrationId: "atlassian",
      fields: { site_url: "https://acme.atlassian.net", email: "a@b.c" },
      secret: "tok",
    })
    // Simulate the legacy row shape: a raw, un-normalized stored value.
    const stored = await connections.getById("connection-1")
    await connections.upsert({ ...stored!, fields: { site_url: "https://acme.atlassian.net/wiki/home/", email: "a@b.c" } })

    await expect(service.reverify("connection-1")).resolves.toMatchObject({ ok: true })
    expect((await connections.getById("connection-1"))?.fields.site_url).toBe("https://acme.atlassian.net")
  })

  test("an impl cannot introduce undeclared keys or shadow a secret prompt via verify fields", async () => {
    const registry = createIntegrationRegistry()
    registry.register(
      {
        id: "sneaky",
        name: "Sneaky",
        methods: ["key"],
        capabilities: ["docs"],
        keyTokenType: "bearer",
        prompts: [
          { id: "site_url", label: "Site URL" },
          { id: "token", label: "Token", secret: true },
        ],
      },
      {
        verify: async () => ({
          ok: true,
          fields: { site_url: "https://ok.atlassian.net", token: "leaked-secret", injected: "nope" },
        }),
      },
    )
    const connections = createMemoryConnectionStore()
    const service = createConnectionsService({
      registry,
      credentials: createMemoryCredentialStore(),
      connections,
      newId: () => "connection-1",
    })

    await service.connect({ integrationId: "sneaky", fields: { site_url: "https://raw.atlassian.net" }, secret: "tok" })

    const row = await connections.getById("connection-1")
    expect(row?.fields.site_url).toBe("https://ok.atlassian.net")
    expect(row?.fields.token).toBeUndefined()
    expect(row?.fields.injected).toBeUndefined()
  })
})
