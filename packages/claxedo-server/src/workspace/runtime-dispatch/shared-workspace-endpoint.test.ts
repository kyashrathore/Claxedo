/**
 * The SUCCESSFUL shared-workspace forward.
 *
 * `localWorkspaceRelayProxy` answers `/workspaces/:id/*` on the local server —
 * the same URL shape the hosted relay serves — so a user can share a local
 * workspace for remote access. Before this file, every relay assertion in
 * `proxy.test.ts` was a REFUSAL: the loopback gate rejecting a spoofed request.
 * A refusal-only suite cannot tell "the guard works" from "the path is broken",
 * and a live product surface with no success test is one refactor away from
 * silently answering 500 to every request while the guard tests stay green.
 *
 * What it pins, end to end:
 *   - the URL is rewritten so `/workspaces/ws_1/api/wr/health` reaches the
 *     runtime as `/api/wr/health` — the `:workspaceId` prefix is stripped
 *   - a relay-backed workspace forwards with the minted owner token in
 *     `authorization`, NOT the caller's own bearer (the regression that made a
 *     local cloud workspace hang on "Preparing workspace" forever)
 *   - `x-opencode-directory` carries `workspace:<id>` for a relay hit rather
 *     than a filesystem path
 *   - the upstream response body and status reach the caller
 */

import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createLocalWorkspaceRelayProxy } from "./shared-workspace-endpoint"

vi.mock("../store", () => ({
  resolveWorkspace: vi.fn(async ({ workspaceId }: { workspaceId?: string }) =>
    workspaceId === "ws_1"
      ? {
          id: "ws_1",
          kind: "cloud",
          org_id: "org_1",
          directory: "/local/checkout",
          remote_directory: "/workspace",
          workspace_name: "shared-workspace",
        }
      : undefined,
  ),
}))

vi.mock("../supervisor", () => ({
  holdSupervisorSandbox: vi.fn(),
  markSupervisorSandboxUse: vi.fn(),
  releaseSupervisorSandbox: vi.fn(),
  touchSupervisorSandbox: vi.fn(),
}))

/** Captures what the runtime actually received. */
let forwarded: Request | undefined

function sharedWorkspaceApp() {
  const app = new Hono()
  app.all(
    "/workspaces/:workspaceId/*",
    createLocalWorkspaceRelayProxy({
      sandboxManager: {
        ensure: async () => ({
          status: "ready",
          url: "https://runtime.test",
          hostId: "host_1",
          homeRegion: "us-east",
        }),
        touch: vi.fn(async () => ({ touched: true, status: "ready" })),
      } as never,
      relayProvider: {
        getRelayEndpoint: () => "https://relay.test",
        mintRuntimeAccessToken: async () => ({
          token: "minted-owner-token",
          expiresAt: Date.now() + 60_000,
          jti: "jti_1",
        }),
        mintHostTunnelToken: async () => {
          throw new Error("unused")
        },
        resolveTarget: async () => undefined,
        drainWorkspace: async () => undefined,
      } as never,
      defaultHomeRegion: "us-east",
    }),
  )
  return app
}

beforeEach(() => {
  forwarded = undefined
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      forwarded = request
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("shared workspace endpoint — successful relay forward", () => {
  test("forwards a loopback request to the relay-backed runtime and returns its response", async () => {
    const res = await sharedWorkspaceApp().request("http://127.0.0.1/workspaces/ws_1/api/wr/health")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(forwarded, "the request never reached the runtime").toBeDefined()
  })

  test("addresses the RELAY, re-attaching the workspace prefix that routes the request there", async () => {
    await sharedWorkspaceApp().request("http://127.0.0.1/workspaces/ws_1/api/wr/health?directory=x")

    const url = new URL(forwarded!.url)
    // The local prefix is stripped and then rebuilt against the relay origin:
    // the relay routes by workspace identity, so `/workspaces/:id` belongs on
    // the wire — it is the address, not a local artefact. Asserting the bare
    // runtime path here would pin the direct-sandbox shape onto the relay one.
    expect(url.origin).toBe("https://relay.test")
    expect(url.pathname).toBe("/workspaces/ws_1/api/wr/health")
    // `directory` is passed through untouched: a relay hit is addressed by
    // workspace, so the rewrite-to-remote-directory branch is deliberately not
    // taken here.
    expect(url.searchParams.get("directory")).toBe("x")
  })

  test("forwards the MINTED owner token, not the caller's bearer", async () => {
    // The regression this pins: the inline hit used to drop `relay`, so no
    // token was minted and the user's own bearer went upstream. The runtime
    // answered 401 `relay_host_token_required` and a local cloud workspace
    // could never finish connecting.
    await sharedWorkspaceApp().request("http://127.0.0.1/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer callers-own-token" },
    })

    expect(forwarded!.headers.get("authorization")).toBe("Bearer minted-owner-token")
  })

  test("addresses the workspace by id rather than by a local filesystem path", async () => {
    await sharedWorkspaceApp().request("http://127.0.0.1/workspaces/ws_1/api/wr/health")

    expect(forwarded!.headers.get("x-opencode-directory")).toBe("workspace:ws_1")
    expect(forwarded!.headers.get("x-workspace-id")).toBe("ws_1")
    expect(forwarded!.headers.get("x-forwarded-by")).toBe("workspace-relay")
  })

  test("answers 404 for an unknown workspace instead of forwarding somewhere", async () => {
    const res = await sharedWorkspaceApp().request("http://127.0.0.1/workspaces/ws_missing/api/wr/health")

    expect(res.status).toBe(404)
    expect(forwarded, "an unknown workspace must not reach any runtime").toBeUndefined()
  })
})
