import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { createControlPlaneChannels, mountControlPlaneChannels } from "./control-plane"
import type { ControlPlaneServices } from "../authority/services"

/**
 * The pairing admin bearer gate. Loopback callers are admitted unconditionally;
 * a non-loopback caller must present `Bearer ${CLAXEDO_CHANNEL_ADMIN_TOKEN}` —
 * the comparison is what this file exercises. In-process Requests carry no
 * transport peer, so the loopback classifier falls back to the Host header:
 * `https://admin.example.test/...` takes the remote branch, `http://127.0.0.1`
 * the loopback one.
 */

const ADMIN_TOKEN = "0123456789abcdef0123456789abcdef"

function pairingAdminApp(env: Record<string, string>) {
  const channels = {
    access: {
      listPending: vi.fn(async () => []),
      approve: vi.fn(async () => ({ ok: true as const, channel: "telegram", externalUserId: "u_1" })),
    },
    ingress: new Hono(),
  } as unknown as ReturnType<typeof createControlPlaneChannels>
  const app = new Hono()
  mountControlPlaneChannels(app, {
    services: {} as ControlPlaneServices,
    runtime: {} as never,
    env,
    channels,
    requireLoopbackForFake: false,
  })
  return { app, channels }
}

describe("pairing admin bearer gate", () => {
  test("a loopback caller is admitted without a token", async () => {
    const { app, channels } = pairingAdminApp({})
    const res = await app.request("http://127.0.0.1/api/channels/pairing")
    expect(res.status).toBe(200)
    expect(channels.access.listPending).toHaveBeenCalled()
  })

  test("a remote caller with the correct bearer token is admitted", async () => {
    const { app } = pairingAdminApp({ CLAXEDO_CHANNEL_ADMIN_TOKEN: ADMIN_TOKEN })
    const res = await app.request("https://admin.example.test/api/channels/pairing", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(200)
  })

  test("a remote caller with an invalid or unequal-length token is refused", async () => {
    const { app, channels } = pairingAdminApp({ CLAXEDO_CHANNEL_ADMIN_TOKEN: ADMIN_TOKEN })
    for (const authorization of [
      `Bearer ${"0".repeat(ADMIN_TOKEN.length)}`,
      `Bearer ${ADMIN_TOKEN.slice(0, -1)}`,
      `Bearer ${ADMIN_TOKEN}x`,
      `Token ${ADMIN_TOKEN}`,
      "",
    ]) {
      const res = await app.request("https://admin.example.test/api/channels/pairing", {
        headers: authorization ? { authorization } : {},
      })
      expect(res.status, authorization || "(no header)").toBe(401)
    }
    expect(channels.access.listPending).not.toHaveBeenCalled()
  })

  test("a remote caller is refused when no admin token is configured", async () => {
    const { app } = pairingAdminApp({})
    const res = await app.request("https://admin.example.test/api/channels/pairing", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(401)
  })

  test("the same gate guards approve", async () => {
    const { app, channels } = pairingAdminApp({ CLAXEDO_CHANNEL_ADMIN_TOKEN: ADMIN_TOKEN })
    const denied = await app.request("https://admin.example.test/api/channels/pairing/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN.slice(1)}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC123" }),
    })
    expect(denied.status).toBe(401)
    expect(channels.access.approve).not.toHaveBeenCalled()

    const allowed = await app.request("https://admin.example.test/api/channels/pairing/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC123" }),
    })
    expect(allowed.status).toBe(200)
    expect(channels.access.approve).toHaveBeenCalledWith("ABC123", "admin:route")
  })
})
