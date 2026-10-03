import { expect, test } from "bun:test"
import { HOSTED_OPERATIONS, decodeHostedResult, resolveHostedOperation } from "./hosted-operations"

test("desktop cleanup mint is a main-only named operation without session or workspace input", () => {
  expect(HOSTED_OPERATIONS["session.cleanup.grant.desktop"].exposure).toEqual({ renderer: false, app: false })
  expect(resolveHostedOperation("session.cleanup.grant.desktop")).toEqual({
    method: "POST", path: "/api/claxedo/session-cleanup/grant/desktop", body: {},
  })
  expect(resolveHostedOperation("session.cleanup.grant.desktop", { orgId: "org_1", actorId: "supplied", origin: "https://evil.example", token: "supplied" })).toEqual({
    method: "POST", path: "/api/claxedo/session-cleanup/grant/desktop", body: { orgId: "org_1" },
  })
})

test("desktop cleanup codec keeps issuer actor/org and excludes an issuer-supplied origin", () => {
  const canonical = { token: "grant", expiresAt: 1_800_000_000_000, actorId: "actor", orgId: "org" }
  expect(decodeHostedResult("session.cleanup.grant.desktop", { ...canonical, origin: "https://evil.example" })).toEqual(canonical)
  for (const malformed of [{ ...canonical, expiresAt: "tomorrow" }, { ...canonical, expiresAt: NaN }, { ...canonical, token: "" }, { ...canonical, actorId: null }, { ...canonical, orgId: "" }]) {
    expect(() => decodeHostedResult("session.cleanup.grant.desktop", malformed)).toThrow("unexpected shape")
  }
})
