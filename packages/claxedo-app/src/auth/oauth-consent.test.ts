import { describe, expect, test } from "bun:test"
import { carriedScopes, consentDefaults, consentRequester, offeredMcpScopes, requestedScopes } from "./oauth-consent"

const query = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`

describe("consentRequester", () => {
  test("names a deployment-registered client with the deployment's own name, whatever it declares", () => {
    const search = query({ client_id: "claxedo-desktop", redirect_uri: "http://127.0.0.1:5000/claxedo/auth/callback" })

    expect(consentRequester(search, "claxedo-desktop", "Totally Legit")).toEqual({ kind: "deployment", name: "Claxedo Desktop" })
  })

  test("marks a self-registered client unverified, quoting its declared name and where access is sent", () => {
    const search = query({ client_id: "dyn_123", redirect_uri: "https://evil.example/cb" })

    expect(consentRequester(search, "dyn_123", "claxedo-desktop")).toEqual({
      kind: "unverified",
      clientId: "dyn_123",
      declaredName: "claxedo-desktop",
      redirectHost: "evil.example",
    })
  })

  test("never treats an inherited object key as a deployment client", () => {
    for (const clientId of ["constructor", "__proto__", "toString"]) {
      expect(consentRequester(query({ client_id: clientId }), clientId, undefined).kind).toBe("unverified")
    }
  })

  test("omits the redirect host when the query carries no parseable redirect", () => {
    expect(consentRequester(query({ client_id: "dyn_1", redirect_uri: "not a url" }), "dyn_1", undefined)).toEqual({ kind: "unverified", clientId: "dyn_1" })
  })
})

describe("consentDefaults", () => {
  test("pre-checks nothing for an unverified client", () => {
    expect(consentDefaults({ kind: "unverified", clientId: "dyn_1" })).toEqual([])
  })

  test("pre-checks read and act for a deployment client", () => {
    expect(consentDefaults({ kind: "deployment", name: "Claxedo CLI" })).toEqual(["claxedo:read", "claxedo:act"])
  })
})

describe("scope narrowing", () => {
  test("offers admin only to deployment clients and never carries it", () => {
    const scopes = requestedScopes(query({ scope: "offline_access claxedo:admin claxedo:read" }))

    expect(offeredMcpScopes(scopes, "dyn_1").map((entry) => entry.scope)).toEqual(["claxedo:read"])
    expect(offeredMcpScopes(scopes, "claxedo-cli").map((entry) => entry.scope)).toEqual(["claxedo:read", "claxedo:admin"])
    expect(carriedScopes(scopes)).toEqual(["offline_access"])
  })
})
