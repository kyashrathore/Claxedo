import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { SessionAccessPolicy, SessionAccessPolicyInput } from "../session-access-policy"
import {
  authorizeSessionEventScope,
  isSessionEventScopeResponse,
  type SessionEventScope,
  waitForSessionEventStream,
  watchSessionEventLease,
} from "./session-event-privacy"

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
  app.get("/event", async (c) => {
    const scope = await authorizeSessionEventScope(c, accessPolicy, "sessionID")
    if (isSessionEventScopeResponse(scope)) return scope
    capture?.(scope)
    return c.text("ok")
  })
  return app
}

describe("managed session event stream leases", () => {
  test("fails closed when a managed policy cannot renew stream authority", async () => {
    const accessPolicy = policy({ authorizeStream: undefined })
    const response = await verifiedApp(accessPolicy).request("http://localhost/event?sessionID=ses_1")

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "session_stream_authority_required" } })
  })

  test("exchanges the establishment RHT for a lease and does not retain the credential", async () => {
    let initial: SessionAccessPolicyInput | undefined
    let scope: SessionEventScope | undefined
    const accessPolicy = policy({
      authorizeStream: (input) => {
        initial = input
        return { allowed: true, lease: "lease_1", expiresAt: Date.now() + 60_000 }
      },
    })
    const response = await verifiedApp(accessPolicy, (value) => { scope = value }).request(
      "http://localhost/event?sessionID=ses_1",
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
      expect(scope.renewalInput.credential).toBeUndefined()
      expect(scope.expiresAt).toBeLessThanOrEqual(Date.now() + 15_000)
    }
  })

  test("renews before expiry and revokes immediately on the next denial", async () => {
    let now = 1_000
    let scheduled: Array<{ callback: () => void; delayMs: number }> = []
    let cleared = 0
    let revoked = 0
    const renewals: Array<{ lease?: string; credential?: string }> = []
    const accessPolicy = policy({
      authorizeStream: (input, lease) => {
        renewals.push({ lease, credential: input.credential })
        return lease === "lease_1"
          ? { allowed: true, lease: "lease_2", expiresAt: 3_000 }
          : { allowed: false, status: 403, code: "session_revoked", message: "revoked" }
      },
    })
    const scope: SessionEventScope = {
      managed: true,
      sessionId: "ses_1",
      lease: "lease_1",
      expiresAt: 2_000,
      renewalInput: { operation: "session_event_stream", sessionId: "ses_1" },
    }
    const stop = watchSessionEventLease(scope, accessPolicy, () => { revoked += 1 }, {
      now: () => now,
      jitter: () => 0,
      setTimer: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => { cleared += 1 },
    })

    now = 1_750
    scheduled.sort((left, right) => left.delayMs - right.delayMs).shift()?.callback()
    await flushAsync()
    expect(renewals).toEqual([{ lease: "lease_1", credential: undefined }])
    expect(revoked).toBe(0)

    now = 2_500
    scheduled = scheduled.slice(-2)
    scheduled.sort((left, right) => left.delayMs - right.delayMs).shift()?.callback()
    await flushAsync()
    expect(renewals).toEqual([
      { lease: "lease_1", credential: undefined },
      { lease: "lease_2", credential: undefined },
    ])
    expect(revoked).toBe(1)

    stop()
    expect(cleared).toBeGreaterThan(0)
  })

  test("hard-closes at lease expiry while a renewal request is stalled", async () => {
    let now = 1_000
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    let revoked = 0
    const accessPolicy = policy({
      authorizeStream: () => new Promise(() => {}),
    })
    const scope: SessionEventScope = {
      managed: true,
      sessionId: "ses_1",
      lease: "lease_1",
      expiresAt: 2_000,
      renewalInput: { operation: "session_event_stream", sessionId: "ses_1" },
    }
    watchSessionEventLease(scope, accessPolicy, () => { revoked += 1 }, {
      now: () => now,
      jitter: () => 0,
      setTimer: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    expect(scheduled.map((item) => item.delayMs).sort((left, right) => left - right)).toEqual([expect.any(Number), 1_000])
    scheduled.sort((left, right) => left.delayMs - right.delayMs)[0]?.callback()
    await Promise.resolve()
    expect(revoked).toBe(0)

    now = 2_000
    scheduled.find((item) => item.delayMs === 1_000)?.callback()
    await flushAsync()
    expect(revoked).toBe(1)
  })

  test("fails closed immediately when a synchronous renewal policy throws", async () => {
    let now = 1_000
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    let revoked = 0
    const accessPolicy = policy({
      authorizeStream: () => { throw new Error("synchronous oracle failure") },
    })
    const scope: SessionEventScope = {
      managed: true,
      sessionId: "ses_1",
      lease: "lease_1",
      expiresAt: 2_000,
      renewalInput: { operation: "session_event_stream", sessionId: "ses_1" },
    }
    watchSessionEventLease(scope, accessPolicy, () => { revoked += 1 }, {
      now: () => now,
      jitter: () => 0,
      setTimer: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    now = 1_700
    scheduled.sort((left, right) => left.delayMs - right.delayMs)[0]?.callback()
    await flushAsync()
    expect(revoked).toBe(1)
  })

  test("disconnect teardown aborts an in-flight renewal request", async () => {
    let now = 1_000
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    let renewalStarted = false
    let renewalAborted = false
    const accessPolicy = policy({
      authorizeStream: (input) => new Promise((_resolve, reject) => {
        renewalStarted = true
        input.signal?.addEventListener("abort", () => {
          renewalAborted = true
          reject(input.signal?.reason)
        }, { once: true })
      }),
    })
    const scope: SessionEventScope = {
      managed: true,
      sessionId: "ses_1",
      lease: "lease_1",
      expiresAt: 2_000,
      renewalInput: { operation: "session_event_stream", sessionId: "ses_1" },
    }
    const stop = watchSessionEventLease(scope, accessPolicy, () => {}, {
      now: () => now,
      jitter: () => 0,
      setTimer: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    now = 1_700
    scheduled.sort((left, right) => left.delayMs - right.delayMs)[0]?.callback()
    await flushAsync()
    expect(renewalStarted).toBe(true)
    stop()
    await flushAsync()
    expect(renewalAborted).toBe(true)
  })

  test("revocation closes a route stream and runs subscription cleanup exactly once", async () => {
    let authorizationCalls = 0
    let cleanupCalls = 0
    let closeCalls = 0
    let abort: (() => void) | undefined
    const accessPolicy = policy({
      authorizeStream: () => {
        authorizationCalls += 1
        return authorizationCalls === 1
          ? { allowed: true, lease: "lease_1", expiresAt: Date.now() + 30 }
          : { allowed: false, status: 403, code: "session_revoked", message: "revoked" }
      },
    })
    const scope: SessionEventScope = {
      managed: true,
      sessionId: "ses_1",
      lease: "lease_1",
      expiresAt: Date.now() + 30,
      renewalInput: { operation: "session_event_stream", sessionId: "ses_1" },
    }
    const stream = {
      onAbort(callback: () => void) {
        abort = callback
      },
      async close() {
        closeCalls += 1
        abort?.()
      },
    }

    await waitForSessionEventStream(stream, scope, accessPolicy, () => {
      cleanupCalls += 1
    })
    abort?.()

    expect(authorizationCalls).toBeGreaterThanOrEqual(2)
    expect(closeCalls).toBe(1)
    expect(cleanupCalls).toBe(1)
  })
})
