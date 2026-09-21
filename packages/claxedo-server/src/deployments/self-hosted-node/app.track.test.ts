import { describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import {
  ControlPlaneAuthError,
  customVerifierAuthAdapter,
  type ControlPlaneAuthAdapter,
  type VerifiedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { createDurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import { createControlPlaneServices } from "../../authority/services"
import { createProjectionStore } from "../../authority/projection-store"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import { createSelfHostedApp } from "./app"

/**
 * `/api/claxedo/track` identity admission. The route attributes every event to
 * an identity it derives itself: the verified subject in a signed deployment,
 * the machine's own bucket in unsigned-local mode (where the global gate has
 * already bounded the caller to loopback). A client-supplied distinctId is
 * never honored.
 */

const SUBJECT = "user-1"

const signedAuth = customVerifierAuthAdapter({
  issuer: "https://issuer.example.test",
  verifier: async (token): Promise<VerifiedControlPlaneAuth> => {
    if (token !== "valid-token") {
      throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
    }
    return {
      mode: "signed",
      user: { subject: SUBJECT, tokenIdentifier: `issuer|${SUBJECT}`, issuer: "https://issuer.example.test" },
    }
  },
})

function fakeSync() {
  return {
    sync_session_meta: vi.fn(async () => {}),
    sync_session_metas: vi.fn(async () => {}),
    sync_session_messages: vi.fn(async () => {}),
    put_session_meta: vi.fn(async () => {}),
    delete_session_meta: vi.fn(async () => {}),
    session_meta: vi.fn(async (_sessionID: string): Promise<SessionMeta | undefined> => undefined),
    session_metas: vi.fn(async () => new Map()),
    list_session_metas: vi.fn(async () => []),
    tagged_session_metas: vi.fn(async () => []),
    persist_message_event: vi.fn(),
    read_session_messages: vi.fn(() => []),
    read_session_max_event_ordinal: vi.fn(() => 0),
  }
}

function trackedApp(auth?: ControlPlaneAuthAdapter) {
  const sync = fakeSync()
  const capture = vi.fn()
  const services = createControlPlaneServices(
    {
      projectionStore: createProjectionStore(sync),
      durableSessionLog: createDurableSessionLog(sync),
    },
    {
      authority: testManagedSessionAuthority(),
      telemetry: { capture },
      ...(auth ? { auth } : {}),
    },
  )
  return { app: createSelfHostedApp(services).app, capture }
}

function track(app: Hono, init: { headers?: Record<string, string>; body?: string } = {}) {
  return app.request("http://localhost/api/claxedo/track", {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body,
  })
}

describe("POST /api/claxedo/track on a signed node", () => {
  test("denies anonymous and invalid-token callers before parsing", async () => {
    const { app, capture } = trackedApp(signedAuth)
    for (const headers of [{}, { authorization: "Bearer forged" }] as Record<string, string>[]) {
      const response = await track(app, { headers, body: "invalid-json" })
      expect(response.status).toBe(401)
    }
    expect(capture).not.toHaveBeenCalled()
  })

  test("attributes a valid event to the verified subject, ignoring a supplied distinctId", async () => {
    const { app, capture } = trackedApp(signedAuth)
    const response = await track(app, {
      headers: { authorization: "Bearer valid-token" },
      body: JSON.stringify({ distinctId: "spoofed-user", event: "session.created", properties: { surface: "session" } }),
    })
    expect(response.status).toBe(200)
    expect(capture).toHaveBeenCalledWith(SUBJECT, "session.created", { surface: "session" })
  })

  test("rejects a schema-invalid body from an authenticated caller", async () => {
    const { app, capture } = trackedApp(signedAuth)
    const response = await track(app, {
      headers: { authorization: "Bearer valid-token" },
      body: JSON.stringify({ properties: {} }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "telemetry_invalid_body" } })
    expect(capture).not.toHaveBeenCalled()
  })
})

describe("POST /api/claxedo/track on an unsigned-local node", () => {
  test("loopback callers still capture into the machine bucket", async () => {
    const { app, capture } = trackedApp()
    const response = await track(app, {
      body: JSON.stringify({ distinctId: "spoofed-user", event: "session.created" }),
    })
    expect(response.status).toBe(200)
    expect(capture).toHaveBeenCalledWith("local", "session.created", undefined)
  })

  test("non-loopback callers are denied by the unsigned-local gate before the route", async () => {
    const { app, capture } = trackedApp()
    const response = await app.request("http://remote.example.test/api/claxedo/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "session.created" }),
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unsigned_local_loopback_required" } })
    expect(capture).not.toHaveBeenCalled()
  })
})
