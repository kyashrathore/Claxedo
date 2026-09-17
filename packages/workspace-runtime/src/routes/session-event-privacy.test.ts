import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { SessionAccessPolicy, SessionAccessPolicyInput } from "../session-access-policy"
import {
  authorizeSessionEventScope,
  isSessionEventScopeResponse,
  type SessionEventScope,
} from "./session-event-privacy"

function policy(overrides: Partial<SessionAccessPolicy> = {}): SessionAccessPolicy {
  return {
    sessionAuthority: "managed-private",
    authorize: () => ({ allowed: true }),
    authorizePrefix: () => ({ allowed: true }),
    filterSessions: (input) => input.sessionIds,
    registerSession: () => ({ allowed: true }),
    authorizeStream: () => ({ allowed: true, lease: "lease_1", expiresAt: Date.now() + 60_000 }),
    ...overrides,
  }
}

function verifiedApp(accessPolicy: SessionAccessPolicy, capture?: (scope: SessionEventScope) => void) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    ;(c as any).set("relayHostAuth", {
      actor_id: "actor_1",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "editor",
    })
    await next()
  })
  app.get("/api/wr/events", async (c) => {
    const scope = await authorizeSessionEventScope(c, accessPolicy)
    if (isSessionEventScopeResponse(scope)) return scope
    capture?.(scope)
    return c.text("ok")
  })
  return app
}

describe("managed session event stream leases", () => {
  test("fails closed when a managed policy cannot renew stream authority", async () => {
    const accessPolicy = policy({ authorizeStream: undefined })
    const response = await verifiedApp(accessPolicy).request("http://localhost/api/wr/events?sessionID=ses_1")

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "session_stream_authority_required" } })
  })

  test("exchanges the establishment RHT for a session lease bounded by the runtime's clock", async () => {
    let initial: SessionAccessPolicyInput | undefined
    let scope: SessionEventScope | undefined
    const accessPolicy = policy({
      authorizeStream: (input) => {
        initial = input
        return { allowed: true, lease: "lease_1", expiresAt: Date.now() + 60_000 }
      },
    })
    const response = await verifiedApp(accessPolicy, (value) => { scope = value }).request(
      "http://localhost/api/wr/events?sessionID=ses_1",
      { headers: { authorization: "Bearer rht_secret" } },
    )

    expect(response.status).toBe(200)
    expect(initial).toMatchObject({
      credential: "Bearer rht_secret",
      operation: "session_event_stream",
      sessionId: "ses_1",
      actor: { actorId: "actor_1", actorKind: "human" },
      authority: { orgId: "org_1", workspaceId: "ws_1", role: "editor" },
    })
    expect(scope?.managed).toBe(true)
    if (scope?.managed) {
      expect(scope.lease).toBe("lease_1")
      expect(scope.expiresAt).toBeLessThanOrEqual(Date.now() + 15_000)
    }
  })
})
