import { WorkspaceRuntimeClientError } from "@claxedo/workspace-runtime/client"
import { describe, expect, test } from "vitest"
import type { ClaxedoFetch } from "./contract"
import { ClaxedoMcpClientError, createClaxedoMcpClient } from "./index"
import {
  controlPlaneWorkspaceRow,
  workspaceListHostRows,
  type ControlPlaneWorkspaceRow,
} from "./control-plane-workspaces.fixture"

type Call = { method: string; path: string; headers: Headers; body?: string }

function recorder(handle: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchLike = async (input: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: input,
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    }
    calls.push(call)
    return handle(call)
  }
  return { calls, fetch: fetchLike as ClaxedoFetch & ((input: string, init?: RequestInit) => Promise<Response>) }
}

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`
}

/**
 * A control plane that mints workspace tokens and a relay that admits only the
 * tokens that control plane minted and has not revoked.
 */
function hostedFixture(input: { now: () => number; ttlMs?: number; relayUrl?: string; provisioningRounds?: number }) {
  const relayUrl = input.relayUrl ?? "https://relay.example"
  const ttlMs = input.ttlMs ?? 15 * 60_000
  const live = new Set<string>()
  let minted = 0
  let refuseAll = false
  let provisioningLeft = input.provisioningRounds ?? 0
  const mint = (workspaceId: string) => {
    minted += 1
    const jti = `jti-${minted}`
    live.add(jti)
    return Response.json({
      backing: "cloud-vm",
      sessionAuthority: "managed-private",
      workspaceId,
      homeRegion: "iad",
      relayUrl: `${relayUrl}/`,
      runtimeAccessToken: jwt({ jti, ws: workspaceId }),
      tokenExpiresAt: input.now() + ttlMs,
      role: "owner",
      hostId: "host-1",
    })
  }
  const controlPlane = recorder((call) => {
    const connection = /^\/api\/workspace\/([^/]+)\/connection(\/refresh)?$/.exec(call.path)
    if (connection) {
      if (!call.headers.has("authorization") && provisioningLeft > 0) {
        provisioningLeft -= 1
        return Response.json({ status: "provisioning", workspaceId: connection[1], retryAfterMs: 5 })
      }
      if (connection[2]) {
        const previousJti = JSON.parse(call.body ?? "{}").previousJti
        if (typeof previousJti === "string") live.delete(previousJti)
      }
      return mint(decodeURIComponent(connection[1]))
    }
    if (call.path.startsWith("/api/workspace?host=")) {
      const rows = [
        controlPlaneWorkspaceRow({ workspace_id: "ws-cloud", backing: "cloud-vm", display_name: "Cloud box" }),
        controlPlaneWorkspaceRow({ workspace_id: "ws-mac", backing: "local-worktree", display_name: "Mac", remote_directory: "/Users/me/app" }),
        controlPlaneWorkspaceRow({ workspace_id: "ws-laptop", backing: "local-worktree", remote_directory: "/home/me/app", host_online: false, role: "editor" }),
        { backing: "cloud-vm" } as ControlPlaneWorkspaceRow,
      ]
      return Response.json({ workspaces: workspaceListHostRows(rows, new URL(call.path, "http://control.local").searchParams.get("host")) })
    }
    return Response.json({ error: { code: "not_found", message: `no route ${call.path}` } }, { status: 404 })
  })
  const relay = recorder((call) => {
    const token = call.headers.get("authorization")?.replace(/^Bearer /, "")
    const jti = token ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).jti : undefined
    if (refuseAll || typeof jti !== "string" || !live.has(jti)) {
      return Response.json({ error: { code: "invalid_token", message: "relay refused" } }, { status: 401 })
    }
    return Response.json({ ok: true, url: call.path, method: call.method })
  })
  return {
    controlPlane,
    relay,
    revoke: (jti: string) => live.delete(jti),
    refuseEverything: () => { refuseAll = true },
    get minted() { return minted },
  }
}

const local = () => recorder((call) => Response.json({ local: true, url: call.path, method: call.method }))

describe("resolveTarget", () => {
  test("loopback serves its own workspace, any directory, and refuses foreign ids without an account", async () => {
    const runtime = local()
    const client = createClaxedoMcpClient({
      deployment: "loopback",
      local: { fetch: runtime.fetch, workspace: { workspaceId: "ws-own", directory: "/repo" } },
    })
    await expect(client.resolveTarget({})).resolves.toEqual({ kind: "loopback", workspaceId: "ws-own", directory: "/repo", baseUrl: "", headers: {} })
    await expect(client.resolveTarget({ directory: "/repo/worktree" })).resolves.toMatchObject({ kind: "loopback", directory: "/repo/worktree", baseUrl: "" })
    await expect(client.resolveTarget({ workspaceId: "ws-own" })).resolves.toMatchObject({ kind: "loopback", workspaceId: "ws-own" })
    await expect(client.resolveTarget({ workspaceId: "ws-other" })).rejects.toMatchObject({ name: "ClaxedoMcpClientError", code: "control-plane-required" })
    expect(client.ownWorkspace).toEqual({ workspaceId: "ws-own", directory: "/repo" })
    expect(client.controlPlane).toBeUndefined()
    const fetchRuntime = await client.runtime({ directory: "/repo/worktree" })
    await fetchRuntime("/session", { method: "GET" })
    expect(runtime.calls.map((call) => call.path)).toEqual(["/session"])
  })

  test("hosted serves nothing in-process and reaches workspaces only by id", async () => {
    const now = () => 1_000_000
    const fixture = hostedFixture({ now })
    expect(() => createClaxedoMcpClient({ deployment: "hosted" })).toThrow(ClaxedoMcpClientError)
    expect(() =>
      createClaxedoMcpClient({
        deployment: "hosted",
        controlPlane: { fetch: fixture.controlPlane.fetch },
        local: { fetch: local().fetch, workspace: {} },
      }),
    ).toThrow(ClaxedoMcpClientError)
    const client = createClaxedoMcpClient({ deployment: "hosted", controlPlane: { fetch: fixture.controlPlane.fetch }, fetch: fixture.relay.fetch, now })
    expect(client.ownWorkspace).toBeUndefined()
    await expect(client.resolveTarget({ directory: "/repo" })).rejects.toMatchObject({ code: "unresolvable-target" })
    await expect(client.resolveTarget({})).rejects.toMatchObject({ code: "unresolvable-target" })
    await expect(client.resolveTarget({ workspaceId: "ws a" })).resolves.toEqual({
      kind: "relay",
      workspaceId: "ws a",
      baseUrl: "https://relay.example/workspaces/ws%20a",
      headers: { Authorization: `Bearer ${jwt({ jti: "jti-1", ws: "ws a" })}` },
      expiresAt: 1_000_000 + 15 * 60_000,
    })
    expect(fixture.controlPlane.calls.map((call) => [call.method, call.path])).toEqual([["POST", "/api/workspace/ws%20a/connection"]])
  })

  test("node serves its own workspace directly and relays the rest through its own connection route", async () => {
    const now = () => 5_000
    const fixture = hostedFixture({ now, relayUrl: "https://node.example" })
    const runtime = local()
    const client = createClaxedoMcpClient({
      deployment: "node",
      local: { fetch: runtime.fetch, workspace: { workspaceId: "ws-node", directory: "/srv/app" } },
      controlPlane: { fetch: fixture.controlPlane.fetch },
      fetch: fixture.relay.fetch,
      now,
    })
    await expect(client.resolveTarget({ workspaceId: "ws-node" })).resolves.toEqual({ kind: "node", workspaceId: "ws-node", directory: "/srv/app", baseUrl: "", headers: {} })
    await expect(client.resolveTarget({ workspaceId: "ws-mac" })).resolves.toMatchObject({ kind: "relay", baseUrl: "https://node.example/workspaces/ws-mac" })
    await (await client.runtime({}))("/api/wr/process", { method: "GET" })
    await (await client.runtime({ workspaceId: "ws-mac" }))("/api/wr/process", { method: "GET" })
    expect(runtime.calls.map((call) => call.path)).toEqual(["/api/wr/process"])
    expect(fixture.relay.calls.map((call) => call.path)).toEqual(["https://node.example/workspaces/ws-mac/api/wr/process"])
    expect(fixture.controlPlane.calls).toHaveLength(1)
  })
})

describe("hosted relay hop", () => {
  test("a runtime call handshakes once, carries the minted token, and reuses the cached connection", async () => {
    const now = () => 10_000
    const fixture = hostedFixture({ now })
    await expect(fixture.relay.fetch("https://relay.example/workspaces/ws-1/session", { method: "GET" })).resolves.toMatchObject({ status: 401 })

    const client = createClaxedoMcpClient({ deployment: "hosted", controlPlane: { fetch: fixture.controlPlane.fetch }, fetch: fixture.relay.fetch, now })
    const runtime = await client.runtime({ workspaceId: "ws-1" })
    expect(fixture.controlPlane.calls).toHaveLength(0)

    const first = await runtime("/session/abc/prompt_async", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })
    await expect(first.json()).resolves.toEqual({ ok: true, url: "https://relay.example/workspaces/ws-1/session/abc/prompt_async", method: "POST" })
    await runtime("/permission", { method: "GET" })
    expect(fixture.controlPlane.calls.map((call) => call.path)).toEqual(["/api/workspace/ws-1/connection"])
    expect(fixture.relay.calls.slice(1).map((call) => [call.headers.get("authorization"), call.headers.get("content-type")])).toEqual([
      [`Bearer ${jwt({ jti: "jti-1", ws: "ws-1" })}`, "application/json"],
      [`Bearer ${jwt({ jti: "jti-1", ws: "ws-1" })}`, null],
    ])
  })

  test("a 401 from the relay refreshes the token once, then surfaces the second answer", async () => {
    const now = () => 20_000
    const fixture = hostedFixture({ now })
    const client = createClaxedoMcpClient({ deployment: "hosted", controlPlane: { fetch: fixture.controlPlane.fetch }, fetch: fixture.relay.fetch, now })
    const runtime = await client.runtime({ workspaceId: "ws-1" })
    await runtime("/session", { method: "GET" })

    fixture.revoke("jti-1")
    const recovered = await runtime("/session", { method: "GET" })
    expect(recovered.status).toBe(200)
    expect(fixture.controlPlane.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/api/workspace/ws-1/connection", "{}"],
      ["POST", "/api/workspace/ws-1/connection/refresh", JSON.stringify({ previousJti: "jti-1" })],
    ])
    expect(fixture.relay.calls.map((call) => call.headers.get("authorization"))).toEqual([
      `Bearer ${jwt({ jti: "jti-1", ws: "ws-1" })}`,
      `Bearer ${jwt({ jti: "jti-1", ws: "ws-1" })}`,
      `Bearer ${jwt({ jti: "jti-2", ws: "ws-1" })}`,
    ])

    fixture.refuseEverything()
    const spare = fixture.relay.calls.length
    const stillDenied = await runtime("/session", { method: "GET" })
    expect(stillDenied.status).toBe(401)
    expect(fixture.relay.calls.length - spare).toBe(2)
    expect(fixture.minted).toBe(3)
  })

  test("an expiring cached token is refreshed before the next call", async () => {
    let clock = 100_000
    const fixture = hostedFixture({ now: () => clock, ttlMs: 10 * 60_000 })
    const client = createClaxedoMcpClient({ deployment: "hosted", controlPlane: { fetch: fixture.controlPlane.fetch }, fetch: fixture.relay.fetch, now: () => clock, refreshWindowMs: 60_000 })
    const runtime = await client.runtime({ workspaceId: "ws-1" })
    await runtime("/session", { method: "GET" })
    clock += 8 * 60_000
    await runtime("/session", { method: "GET" })
    expect(fixture.controlPlane.calls).toHaveLength(1)
    clock += 90_000
    await runtime("/session", { method: "GET" })
    expect(fixture.controlPlane.calls.map((call) => call.path)).toEqual(["/api/workspace/ws-1/connection", "/api/workspace/ws-1/connection/refresh"])
    expect(fixture.relay.calls.at(-1)?.headers.get("authorization")).toBe(`Bearer ${jwt({ jti: "jti-2", ws: "ws-1" })}`)
    await expect(client.resolveTarget({ workspaceId: "ws-1" })).resolves.toMatchObject({ expiresAt: clock + 10 * 60_000 })
  })

  test("a provisioning workspace is polled until the token arrives, and a refused handshake is the control plane's error", async () => {
    const now = () => 30_000
    const fixture = hostedFixture({ now, provisioningRounds: 2 })
    const waits: number[] = []
    const client = createClaxedoMcpClient({
      deployment: "hosted",
      controlPlane: { fetch: fixture.controlPlane.fetch },
      fetch: fixture.relay.fetch,
      now,
      sleep: async (ms) => { waits.push(ms) },
    })
    await expect(client.resolveTarget({ workspaceId: "ws-1" })).resolves.toMatchObject({ kind: "relay" })
    expect(waits).toEqual([500, 500])
    expect(fixture.controlPlane.calls).toHaveLength(3)

    const refusing = createClaxedoMcpClient({
      deployment: "hosted",
      controlPlane: { fetch: async () => Response.json({ error: { code: "billing_entitlement_required", message: "Subscribe first" } }, { status: 402 }) },
      fetch: fixture.relay.fetch,
    })
    const error = await refusing.resolveTarget({ workspaceId: "ws-1" }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(WorkspaceRuntimeClientError)
    expect(error).toMatchObject({ operation: "workspace.connection", status: 402, code: "billing_entitlement_required", message: "Subscribe first" })

    const stuck = createClaxedoMcpClient({
      deployment: "hosted",
      controlPlane: { fetch: async () => Response.json({ status: "provisioning", retryAfterMs: 1 }) },
      sleep: async () => {},
      provisioningMaxAttempts: 3,
    })
    await expect(stuck.resolveTarget({ workspaceId: "ws-1" })).rejects.toMatchObject({ code: "connection-provisioning" })
  })
})

describe("server()", () => {
  test("types the runtime routes over the in-process fetch and over the relay", async () => {
    const now = () => 40_000
    const fixture = hostedFixture({ now })
    const runtime = local()
    const client = createClaxedoMcpClient({
      deployment: "loopback",
      local: { fetch: runtime.fetch, workspace: { workspaceId: "ws-own", directory: "/repo" } },
      controlPlane: { fetch: fixture.controlPlane.fetch },
      fetch: fixture.relay.fetch,
      now,
    })
    const own = await client.server({})
    await own.session.list({ limit: 5 })
    await own.permission.respond({ sessionID: "s 1", permissionID: "p1", response: "once" })
    expect(runtime.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/session?directory=%2Frepo&workspace=ws-own&limit=5"],
      ["POST", "/session/s%201/permissions/p1?directory=%2Frepo&workspace=ws-own"],
    ])

    const remote = await client.server({ workspaceId: "ws-2" })
    const listed = await remote.session.list()
    expect(listed.request.url).toBe("https://relay.example/workspaces/ws-2/session?workspace=ws-2")
    expect(fixture.relay.calls.map((call) => call.path)).toEqual(["https://relay.example/workspaces/ws-2/session?workspace=ws-2"])
    expect(fixture.relay.calls[0]?.headers.get("authorization")).toBe(`Bearer ${jwt({ jti: "jti-1", ws: "ws-2" })}`)
  })
})

describe("workspaces()", () => {
  test("names the machine each row runs on, asking each host once and keying by id", async () => {
    const fixture = hostedFixture({ now: () => 0 })
    const client = createClaxedoMcpClient({ deployment: "hosted", controlPlane: { fetch: fixture.controlPlane.fetch } })
    await expect(client.workspaces()).resolves.toEqual([
      { id: "ws-cloud", host: "provisioner", name: "Cloud box" },
      { id: "ws-mac", host: "machine", name: "Mac", directory: "/Users/me/app", machineOnline: true },
      { id: "ws-laptop", host: "machine", directory: "/home/me/app", machineOnline: false },
    ])
    expect(fixture.controlPlane.calls.map((call) => call.path)).toEqual(["/api/workspace?host=provisioner", "/api/workspace?host=machine"])
  })

  test("needs an account credential and surfaces the control plane's refusal", async () => {
    const offline = createClaxedoMcpClient({ deployment: "loopback", local: { fetch: local().fetch, workspace: { directory: "/repo" } } })
    await expect(offline.workspaces()).rejects.toMatchObject({ code: "control-plane-required" })
    const refused = createClaxedoMcpClient({
      deployment: "hosted",
      controlPlane: { fetch: async () => Response.json({ error: { code: "rate_limited", message: "Slow down" } }, { status: 429 }) },
    })
    await expect(refused.workspaces()).rejects.toMatchObject({ name: "WorkspaceRuntimeClientError", operation: "workspace.list.provisioner", status: 429, code: "rate_limited" })
  })
})
