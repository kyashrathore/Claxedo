import { afterEach, describe, expect, test, vi } from "vitest"
import { createServer } from "node:http"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL } from "@claxedo/workspace-runtime"
import { WORKSPACE_RUNTIME_SESSION_CLEANUP_GRANT } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { mintSessionCleanupCapability } from "../../session/cleanup-capability"
import { workspaceRuntimeSessionCleanupGrant } from "./session-cleanup-grant"

afterEach(() => vi.useRealTimers())

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signing = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
  const root = { userId: "user-a", actorId: "actor-a", orgId: "org-a", projectId: "project-a", workspaceId: "workspace-a" }
  const mint = (now = Date.now(), sessionId?: string) => mintSessionCleanupCapability({ ...root, ...(sessionId ? { sessionId } : {}) }, signing, { ttlSeconds: 120, now: () => now })
  const initial = await mint()
  const scoped = await mint(Date.now(), "session-a")
  const env = { [WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]: "https://control.test/api/claxedo/runtime/session-authority", [WORKSPACE_RUNTIME_SESSION_CLEANUP_GRANT]: initial.token }
  return { initial, scoped, mint, env }
}

describe("runtime cleanup grant", () => {
  test("has no client for absent or malformed grants", () => {
    expect(workspaceRuntimeSessionCleanupGrant({})).toBeUndefined()
    expect(workspaceRuntimeSessionCleanupGrant({ [WORKSPACE_RUNTIME_SESSION_CLEANUP_GRANT]: "not-a-token" })).toBeUndefined()
  })

  test("sends the current grant only to the two cleanup endpoints", async () => {
    const f = await fixture()
    const send = vi.fn(async (request: Request) => Response.json(new URL(request.url).pathname.endsWith("/grant/session") ? f.scoped : { candidates: [] }))
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    const grant = holder.forSession("session-a", "runtime-proof")!
    expect((await grant.fetch("https://other.test/api/claxedo/session-cleanup")).status).toBe(403)
    expect((await grant.fetch("/api/workspace")).status).toBe(403)
    await grant.fetch("/api/claxedo/session-cleanup?from=2026-01-01T00%3A00%3A00Z")
    expect(send).toHaveBeenCalledTimes(2)
    const issued = send.mock.calls[0]?.[0]
    expect(await issued?.json()).toEqual({ sessionId: "session-a", credential: "runtime-proof" })
    expect(issued?.headers.get("authorization")).toBe(`Bearer ${f.initial.token}`)
    const request = send.mock.calls[1]?.[0]
    expect(request?.headers.get("authorization")).toBe(`Bearer ${f.scoped.token}`)
    expect(request?.redirect).toBe("manual")
  })

  test("renews independently of Tasks and updates an already-created client", async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const next = await f.mint(Date.now() + 60_000)
    let renewed: string | undefined
    const send = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/renew")) {
        renewed = next.token
        return Response.json(next)
      }
      if (new URL(request.url).pathname.endsWith("/grant/session")) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${next.token}`)
        return Response.json(f.scoped)
      }
      return Response.json({ tokenSeen: request.headers.get("authorization") })
    })
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    const grant = holder.forSession("session-a", "runtime-proof")!
    holder.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(renewed).toBeTruthy()
    expect(await (await grant.fetch("/api/claxedo/session-cleanup")).json()).toEqual({ tokenSeen: `Bearer ${f.scoped.token}` })
    holder.stop()
  })

  test("withdrawal removes the client and refuses calls from existing MCP sessions", async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const send = vi.fn(async () => Response.json({ error: { code: "session_cleanup_grant_withdrawn" } }, { status: 403 }))
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    const grant = holder.forSession("session-a", "runtime-proof")!
    holder.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(holder.forSession("session-a", "runtime-proof")).toBeUndefined()
    expect(grant.allowed()).toBe(false)
    expect((await grant.fetch("/api/claxedo/session-cleanup/delete", { method: "POST" })).status).toBe(503)
    expect(send).toHaveBeenCalledTimes(1)
    holder.stop()
  })

  test("a stalled public issuer times out and the same session holder retries successfully", async () => {
    const f = await fixture()
    let issues = 0
    const server = createServer((request, response) => {
      if (request.url === "/api/claxedo/session-cleanup/grant/session" && ++issues === 1) return
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(request.url === "/api/claxedo/session-cleanup/grant/session" ? f.scoped : { candidates: [], incompleteSources: [] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Issuer test server has no address")
    const holder = workspaceRuntimeSessionCleanupGrant({ ...f.env, [WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]: `http://127.0.0.1:${address.port}/api/claxedo/runtime/session-authority` }, { requestTimeoutMs: 100 })!
    try {
      const grant = holder.forSession("session-a", "runtime-proof")!
      await expect(grant.fetch("/api/claxedo/session-cleanup")).rejects.toMatchObject({ name: "TimeoutError" })
      const recovered = await grant.fetch("/api/claxedo/session-cleanup")
      expect(await recovered.json()).toEqual({ candidates: [], incompleteSources: [] })
      expect(issues).toBe(2)
    } finally {
      holder.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test("a root renewal deadline releases its stalled request and schedules recovery", async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const next = await f.mint(Date.now() + 60_000)
    let aborted = false
    let renewals = 0
    const send = vi.fn(async (request: Request) => {
      if (request.url.endsWith("/renew")) {
        if (++renewals === 1) return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => { aborted = true; reject(request.signal.reason) }, { once: true }))
        return Response.json(next)
      }
      if (request.url.endsWith("/grant/session")) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${next.token}`)
        return Response.json(f.scoped)
      }
      return Response.json({ candidates: [] })
    })
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    holder.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(renewals).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(renewals).toBe(2)
    expect((await holder.forSession("session-a", "runtime-proof")!.fetch("/api/claxedo/session-cleanup")).status).toBe(200)
    holder.stop()
  })

  test("caller cancellation releases its own issuer wait without cancelling another caller", async () => {
    const f = await fixture()
    let complete: (response: Response) => void = () => { throw new Error("No issuance request") }
    let issuanceSignal: AbortSignal | undefined
    const send = vi.fn(async (request: Request) => {
      if (request.url.endsWith("/grant/session")) {
        issuanceSignal = request.signal
        return new Promise<Response>((resolve) => { complete = resolve })
      }
      return Response.json({ candidates: [] })
    })
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    const grant = holder.forSession("session-a", "runtime-proof")!
    const caller = new AbortController()
    const reason = new DOMException("Caller cancelled", "AbortError")
    const cancelled = expect(grant.fetch("/api/claxedo/session-cleanup", { signal: caller.signal })).rejects.toBe(reason)
    const other = grant.fetch("/api/claxedo/session-cleanup")
    caller.abort(reason)
    await cancelled
    expect(issuanceSignal?.aborted).toBe(false)
    complete(Response.json(f.scoped))
    expect((await other).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
    holder.stop()
  })

  test("cleanup receipt reads obey caller cancellation and deadlines", async () => {
    vi.useFakeTimers()
    const f = await fixture()
    let bodyAborted = false
    const send = vi.fn(async (request: Request) => {
      if (request.url.endsWith("/grant/session")) return Response.json(f.scoped)
      return new Response(new ReadableStream({ start(controller) {
        request.signal.addEventListener("abort", () => { bodyAborted = true; controller.error(request.signal.reason) }, { once: true })
      } }))
    })
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    const grant = holder.forSession("session-a", "runtime-proof")!
    const caller = new AbortController()
    const reason = new DOMException("Caller cancelled deletion", "AbortError")
    const cancelled = expect(grant.fetch("/api/claxedo/session-cleanup/delete", { method: "POST", signal: caller.signal })).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    caller.abort(reason)
    await cancelled
    expect(bodyAborted).toBe(true)
    bodyAborted = false
    const timed = expect(grant.fetch("/api/claxedo/session-cleanup/delete", { method: "POST" })).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(5_000)
    await timed
    expect(bodyAborted).toBe(true)
    holder.stop()
  })

  test("stopping the owner aborts pending issuance and prevents another request", async () => {
    const f = await fixture()
    let signal: AbortSignal | undefined
    const send = vi.fn(async (request: Request) => { signal = request.signal; return new Promise<Response>(() => {}) })
    const holder = workspaceRuntimeSessionCleanupGrant(f.env, { fetch: send })!
    const grant = holder.forSession("session-a", "runtime-proof")!
    const pending = expect(grant.fetch("/api/claxedo/session-cleanup")).rejects.toMatchObject({ name: "AbortError" })
    holder.stop()
    await pending
    expect(signal?.aborted).toBe(true)
    expect(grant.allowed()).toBe(false)
    expect((await grant.fetch("/api/claxedo/session-cleanup")).status).toBe(503)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
