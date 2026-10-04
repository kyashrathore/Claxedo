import { describe, expect, test, vi } from "vitest"
import { assertToolAccess, McpAccessDenied, type McpToolAccess } from "@claxedo/mcp/context"

import {
  readIntrospectedAccessToken,
  resolveOAuthMcpCredential,
  type OAuthAccessTokenClaims,
} from "./oauth-credential"

const ORIGIN = "https://api.claxedo.test"
const RESOURCE = `${ORIGIN}/api/claxedo/mcp`

/** What a tool that answers a permission prompt declares. */
const PERMISSION_REPLY: McpToolAccess = { audiences: ["user"], write: true, scope: "approve" }
const SESSION_READ: McpToolAccess = { audiences: ["user"], write: false, scope: "read" }

function deps(claims: OAuthAccessTokenClaims | undefined) {
  return {
    verifyAccessToken: vi.fn(() => claims),
    controlPlaneOrigin: () => ORIGIN,
  }
}

function bearer(token: string) {
  return new Request(RESOURCE, { headers: { authorization: `Bearer ${token}` } })
}

describe("resolveOAuthMcpCredential", () => {
  test("maps granted claxedo scopes onto the MCP credential", async () => {
    const credential = await resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["offline_access", "claxedo:read", "claxedo:act"],
      audience: [RESOURCE],
    }))

    expect(credential).toEqual({
      kind: "user",
      actorId: "user-1",
      scopes: new Set(["read", "act"]),
      clientId: "aBcD",
      readOnly: false,
    })
  })

  test("a token holding only read is read-only", async () => {
    const credential = await resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["claxedo:read"],
      audience: [RESOURCE],
    }))

    expect(credential).toMatchObject({ readOnly: true })
  })

  test("a token without approve cannot reply to a permission, but can still read", async () => {
    const credential = await resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["claxedo:read", "claxedo:act"],
      audience: [RESOURCE],
    }))
    if (!credential) throw new Error("expected a credential")

    expect(() => assertToolAccess(credential, "session_permission_reply", PERMISSION_REPLY))
      .toThrow(McpAccessDenied)
    expect(() => assertToolAccess(credential, "session_permission_reply", PERMISSION_REPLY))
      .toThrow(/claxedo:approve/)
    expect(() => assertToolAccess(credential, "session_list", SESSION_READ)).not.toThrow()
  })

  test("a token that was granted approve may reply", async () => {
    const credential = await resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["claxedo:read", "claxedo:act", "claxedo:approve"],
      audience: [RESOURCE],
    }))
    if (!credential) throw new Error("expected a credential")

    expect(() => assertToolAccess(credential, "session_permission_reply", PERMISSION_REPLY)).not.toThrow()
  })

  test("drops admin from a client this deployment did not register", async () => {
    const dynamic = await resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["claxedo:read", "claxedo:admin"],
      audience: [RESOURCE],
    }))
    const cli = await resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "claxedo-cli",
      scopes: ["claxedo:read", "claxedo:admin"],
      audience: [RESOURCE],
    }))

    expect(dynamic?.kind === "user" && [...dynamic.scopes]).toEqual(["read"])
    expect(cli?.kind === "user" && [...cli.scopes]).toEqual(["read", "admin"])
  })

  test("refuses a request with no bearer, an unknown token, or no claxedo scope", async () => {
    await expect(resolveOAuthMcpCredential(new Request(RESOURCE), deps({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["claxedo:read"],
    }))).resolves.toBeUndefined()

    await expect(resolveOAuthMcpCredential(bearer("t"), deps(undefined))).resolves.toBeUndefined()

    await expect(resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "claxedo-cli",
      scopes: ["openid", "workspace:write"],
      audience: [RESOURCE],
    }))).resolves.toBeUndefined()
  })

  test("refuses a live token carrying no audience", async () => {
    await expect(resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "claxedo-cli",
      scopes: ["claxedo:read", "claxedo:act"],
    }))).resolves.toBeUndefined()
  })

  test("refuses a live token minted for another resource", async () => {
    await expect(resolveOAuthMcpCredential(bearer("t"), deps({
      subject: "user-1",
      clientId: "claxedo-cli",
      scopes: ["claxedo:read", "claxedo:act"],
      audience: [`${ORIGIN}/control-plane`],
    }))).resolves.toBeUndefined()
  })
})

describe("readIntrospectedAccessToken", () => {
  test("reads an active token's subject, client and scopes", () => {
    expect(readIntrospectedAccessToken({
      active: true,
      sub: "user-1",
      client_id: "aBcD",
      scope: "claxedo:read claxedo:act",
      aud: RESOURCE,
    })).toEqual({
      subject: "user-1",
      clientId: "aBcD",
      scopes: ["claxedo:read", "claxedo:act"],
      audience: [RESOURCE],
    })
  })

  test("refuses an inactive token and one missing an identity", () => {
    expect(readIntrospectedAccessToken({ active: false, sub: "user-1", client_id: "aBcD" })).toBeUndefined()
    expect(readIntrospectedAccessToken({ active: true, client_id: "aBcD" })).toBeUndefined()
    expect(readIntrospectedAccessToken({ active: true, sub: "user-1" })).toBeUndefined()
    expect(readIntrospectedAccessToken(undefined)).toBeUndefined()
  })
})
