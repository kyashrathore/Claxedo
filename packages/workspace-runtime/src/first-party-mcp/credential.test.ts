import { describe, expect, test } from "bun:test"
import { createRuntimeCredentialIssuer, runtimeCredentialWorkspaceId } from "./credential"

const HOUR = 60 * 60 * 1000

function clock(start = 1_700_000_000_000) {
  let at = start
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

describe("runtime credential issuer", () => {
  test("binds each launched session to signed claims without invalidating sibling tokens", () => {
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1" })
    const parent = issuer.current("ses_parent")
    const child = issuer.current("ses_child")
    expect(parent).not.toBe(child)
    expect(issuer.verify(parent)?.sessionId).toBe("ses_parent")
    expect(issuer.verify(child)?.sessionId).toBe("ses_child")
    const [header, payload, signature] = child.split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
    claims.session_id = "ses_parent"
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`
    expect(issuer.verify(forged)).toBeUndefined()
  })

  test("verifies its own token and surfaces the runtime, workspace, user and lifetime claims", () => {
    const time = clock()
    const issuer = createRuntimeCredentialIssuer({
      runtimeId: "rt-1", workspaceId: "ws-1", userId: "user-1", ttlMs: 2 * HOUR, now: time.now,
    })
    const token = issuer.current()
    expect(issuer.header()).toBe(`Bearer ${token}`)
    expect(token.split(".")).toHaveLength(3)
    expect(issuer.verify(token)).toEqual({
      runtimeId: "rt-1",
      workspaceId: "ws-1",
      userId: "user-1",
      issuedAt: time.now(),
      expiresAt: time.now() + 2 * HOUR,
    })
  })

  test("omits the user claim for an unsigned local runtime", () => {
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1" })
    expect(issuer.verify(issuer.current())).not.toHaveProperty("userId")
  })

  test("refuses an expired, forged, foreign or malformed token", () => {
    const time = clock()
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1", ttlMs: HOUR, now: time.now })
    const token = issuer.current()
    const [header, payload, signature] = token.split(".") as [string, string, string]

    const other = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1", ttlMs: HOUR, now: time.now })
    expect(other.verify(token)).toBeUndefined()

    const forgedPayload = Buffer.from(JSON.stringify({
      iss: "claxedo-workspace-runtime", aud: "claxedo-mcp", sub: "rt-1", workspace_id: "ws-2",
      iat: Math.floor(time.now() / 1000), exp: Math.floor((time.now() + HOUR) / 1000), jti: "x",
    })).toString("base64url")
    expect(issuer.verify(`${header}.${forgedPayload}.${signature}`)).toBeUndefined()
    expect(issuer.verify(`${header}.${payload}.${signature.slice(0, -1)}A`)).toBeUndefined()
    expect(issuer.verify(`${header}.${payload}`)).toBeUndefined()
    expect(issuer.verify("")).toBeUndefined()
    expect(issuer.verify(`${header}.${payload}.${signature}+`)).toBeUndefined()

    time.advance(HOUR)
    expect(issuer.verify(token)).toBeUndefined()
  })

  test("re-mints once half the lifetime has passed and keeps the earlier token valid until it expires", () => {
    const time = clock()
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1", ttlMs: 2 * HOUR, now: time.now })
    const first = issuer.current()
    time.advance(HOUR - 1)
    expect(issuer.current()).toBe(first)
    time.advance(1)
    const second = issuer.current()
    expect(second).not.toBe(first)
    expect(issuer.verify(first)?.expiresAt).toBe(time.now() - HOUR + 2 * HOUR)
    expect(issuer.verify(second)?.issuedAt).toBe(time.now())
    time.advance(HOUR)
    expect(issuer.verify(first)).toBeUndefined()
    expect(issuer.verify(second)).toBeDefined()
  })

  test("rotation invalidates every earlier token and mints under a new secret", () => {
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1" })
    const before = issuer.current()
    issuer.rotate()
    expect(issuer.verify(before)).toBeUndefined()
    const after = issuer.current()
    expect(after).not.toBe(before)
    expect(issuer.verify(after)?.runtimeId).toBe("rt-1")
  })

  test("two runtimes never accept each other's tokens", () => {
    const a = createRuntimeCredentialIssuer({ runtimeId: "rt-a", workspaceId: "ws-1" })
    const b = createRuntimeCredentialIssuer({ runtimeId: "rt-b", workspaceId: "ws-1" })
    expect(a.verify(b.current())).toBeUndefined()
    expect(b.verify(a.current())).toBeUndefined()
  })

  test("names the workspace of a token without vouching for it, so a multi-runtime host can route to the right verifier", () => {
    const a = createRuntimeCredentialIssuer({ runtimeId: "rt-a", workspaceId: "ws-a" })
    const b = createRuntimeCredentialIssuer({ runtimeId: "rt-b", workspaceId: "ws-b" })
    const token = a.current()
    expect(runtimeCredentialWorkspaceId(token)).toBe("ws-a")
    expect(runtimeCredentialWorkspaceId(b.current())).toBe("ws-b")
    expect(runtimeCredentialWorkspaceId("not.a-token")).toBeUndefined()
    expect(runtimeCredentialWorkspaceId("")).toBeUndefined()
    const [header, payload] = token.split(".") as [string, string]
    expect(runtimeCredentialWorkspaceId(`${header}.${payload}.forged`)).toBe("ws-a")
    expect(a.verify(`${header}.${payload}.forged`)).toBeUndefined()
  })

  test("rejects a non-positive lifetime", () => {
    expect(() => createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1", ttlMs: 0 })).toThrow("ttlMs")
  })
})
