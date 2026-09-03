import { Hono } from "hono"
import { describe, expect, test, vi } from "vitest"
import { withTimeout } from "../../platform/runtime/timeout"
import {
  InternalRelayResolverRoutes,
  type RelayTargetLookup,
} from "../../deployments/shared-routes/internal-relay"

/**
 * Hosted (Worker) relay-resolver behaviour. The hosted deployment injects a
 * hosted-state target lookup and NO local-target loopback fallback. These tests
 * prove the route resolves a user-hosted target from relay lookup state, fails
 * closed on revocation, and never touches the local workspace-store.
 */

const RESOLVER_TOKEN = "hosted-resolver-token"

function buildHostedApp(opts: {
  targetLookup?: RelayTargetLookup
  revocationLookup: (args: { jti: string; workspaceId: string; hostId: string }) => Promise<unknown>
}) {
  const app = new Hono()
  app.route("/", InternalRelayResolverRoutes({
    resolverToken: RESOLVER_TOKEN,
    targetLookup: opts.targetLookup,
    revocationLookup: opts.revocationLookup,
    // Intentionally NO localTargetExists — hosted deployments have no disk store.
  }))
  return app
}

function authed(path: string) {
  return new Request(`http://relay.test${path}`, {
    headers: { authorization: `Bearer ${RESOLVER_TOKEN}` },
  })
}

describe("hosted /internal/relay/target", () => {
  test("resolves a user-hosted target from relay lookup state", async () => {
    const app = buildHostedApp({
      targetLookup: async ({ workspaceId, hostId }) => {
        expect(workspaceId).toBe("ws_1")
        expect(hostId).toBe("host_1")
        // User-hosted host dials out to the relay → baseUrl is empty.
        return { found: true, baseUrl: "", access: "user-hosted", backing: "local-worktree" }
      },
      revocationLookup: async () => ({ active: true }),
    })

    const res = await app.fetch(authed("/internal/relay/target?workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      workspaceId: "ws_1",
      hostId: "host_1",
      baseUrl: "",
      access: "user-hosted",
      backing: "local-worktree",
    })
  })

  test("returns 404 when the hosted lookup does not find the workspace", async () => {
    const app = buildHostedApp({
      targetLookup: async () => ({ found: false, code: "relay_resolver_workspace_not_found" }),
      revocationLookup: async () => ({ active: true }),
    })
    const res = await app.fetch(authed("/internal/relay/target?workspaceId=ws_x&hostId=host_x"))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "relay_resolver_workspace_not_found" } })
  })

  test("fails closed (501) when no target lookup is configured", async () => {
    const app = buildHostedApp({ revocationLookup: async () => ({ active: true }) })
    const res = await app.fetch(authed("/internal/relay/target?workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ error: { code: "relay_resolver_target_unconfigured" } })
  })

  test("maps a timed-out hosted lookup to the standard typed 503 response", async () => {
    vi.useFakeTimers()
    try {
      const app = buildHostedApp({
        targetLookup: () => withTimeout(new Promise<never>(() => undefined), 25),
        revocationLookup: async () => ({ active: true }),
      })
      const pending = app.fetch(authed("/internal/relay/target?workspaceId=ws_1&hostId=host_1"))

      await vi.advanceTimersByTimeAsync(25)
      const response = await pending

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "control_plane_request_timeout",
          message: "Control Plane request timed out",
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("hosted /internal/relay/revocation", () => {
  test("never grants the loopback fallback without a localTargetExists hook", async () => {
    const app = buildHostedApp({
      revocationLookup: async () => ({
        active: false,
        code: "runtime_access_token_workspace_not_found",
        reason: "Runtime Access Token workspace was not found",
      }),
    })
    // Loopback origin + no resolver-token bypass is impossible here (token set),
    // but even a loopback call must stay fail-closed with no local fallback.
    const res = await app.fetch(
      new Request("http://127.0.0.1/internal/relay/revocation?jti=j1&workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: `Bearer ${RESOLVER_TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ active: false, code: "runtime_access_token_workspace_not_found" })
  })

  test("fails closed when the revocation lookup throws", async () => {
    const app = buildHostedApp({
      revocationLookup: async () => {
        throw new Error("authority unreachable")
      },
    })
    const res = await app.fetch(authed("/internal/relay/revocation?jti=j1&workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ active: false, code: "runtime_access_token_lookup_failed" })
  })
})
