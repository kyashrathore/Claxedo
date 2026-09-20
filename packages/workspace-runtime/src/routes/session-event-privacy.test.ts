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

function scopedApp(
  accessPolicy: SessionAccessPolicy,
  options: { stamped: boolean; capture?: (scope: SessionEventScope) => void },
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    if (options.stamped) {
      ;(c as any).set("relayHostAuth", {
        actor_id: "actor_1",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
      })
    }
    await next()
  })
  app.get("/api/wr/events", async (c) => {
    const scope = await authorizeSessionEventScope(c, accessPolicy)
    if (isSessionEventScopeResponse(scope)) return scope
    options.capture?.(scope)
    return c.text("ok")
  })
  return app
}

function verifiedApp(accessPolicy: SessionAccessPolicy, capture?: (scope: SessionEventScope) => void) {
  return scopedApp(accessPolicy, { stamped: true, ...(capture ? { capture } : {}) })
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

  test("refuses a stamped reader the authority keeps out of the workspace, naming the code that sends it to one session", async () => {
    const accessPolicy = policy({
      authorizeHost: () => ({ allowed: false, status: 403, code: "host_authority_denied", message: "denied" }),
    })

    const response = await verifiedApp(accessPolicy).request("http://localhost/api/wr/events")

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_event_stream_denied", cause: "host_authority_denied" },
    })
  })

  test("an UNSTAMPED reader of the same managed runtime gets the broad stream and asks no authority", async () => {
    // The desktop daemon mounts the private-session policy for the members the
    // relay replays onto it, and answers its own user on the same runtime. A
    // reader with no verified stamp is that user: the ingress refuses a relayed
    // request it cannot verify rather than letting it through unstamped, so
    // there is no third case here.
    const asked: string[] = []
    const accessPolicy = policy({
      authorizeHost: () => { asked.push("host"); return { allowed: false, status: 403, code: "host_authority_denied", message: "denied" } },
      authorizeStream: () => { asked.push("stream"); return { allowed: false, status: 403, code: "session_private", message: "denied" } },
    })
    let scope: SessionEventScope | undefined
    const app = scopedApp(accessPolicy, { stamped: false, capture: (value) => { scope = value } })

    const workspaceWide = await app.request("http://localhost/api/wr/events")
    const sessionScoped = await app.request("http://localhost/api/wr/events?sessionID=ses_1")

    expect(workspaceWide.status).toBe(200)
    expect(sessionScoped.status).toBe(200)
    expect(scope).toEqual({ managed: false })
    expect(asked).toEqual([])
  })
})
