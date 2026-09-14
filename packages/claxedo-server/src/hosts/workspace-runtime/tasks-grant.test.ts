import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { workspaceRuntimeTasksCapabilityEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { mintTasksCapability } from "../../tasks/capability"
import { workspaceRuntimeTasksGrant } from "./tasks-grant"

const AUTHORITY = { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://plane.test/api/runtime-authority/session-authorize" }
const RENEW = "https://plane.test/api/claxedo/tasks/grant/renew"
const START = 1_700_000_000_000
const TTL_MS = 30 * 60_000

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...AUTHORITY,
    ...workspaceRuntimeTasksCapabilityEnv({
      token: "capability-token",
      operations: ["read", "create"],
      projectId: "project-a",
    }),
    ...overrides,
  }
}

/** A clock whose timers fire only when the test advances it, in due order. */
function fakeClock(start = START) {
  let now = start
  let nextId = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    now: () => now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++
        timers.set(id, { due: now + ms, fn })
        return id
      },
      clearTimeout: (id: number) => { timers.delete(id) },
    },
    pending: () => [...timers.values()].map((timer) => timer.due - now),
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0]
        if (!next || next[1].due > target) break
        timers.delete(next[0])
        now = next[1].due
        next[1].fn()
        await new Promise((resolve) => setTimeout(resolve, 0))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      now = target
    },
  }
}

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

const scope = { userId: "alice", orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", sessionId: "ses_1" } as const

async function renewingRuntime(answers: (request: Request, attempt: number) => Promise<Response> | Response) {
  const signing = await signingEnv()
  const clock = fakeClock()
  const minted = await mintTasksCapability({ ...scope, operations: ["read", "create"] }, signing, { now: clock.now, ttlSeconds: TTL_MS / 1_000 })
  let attempts = 0
  const fetch = vi.fn(async (request: Request) => {
    if (request.url === RENEW) return await answers(request, (attempts += 1))
    return new Response("{}")
  })
  const log = { info: vi.fn(), warn: vi.fn() }
  const ownerGrant = { swap: vi.fn<(token: string) => void>() }
  const grant = workspaceRuntimeTasksGrant(
    env({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: minted.token }),
    { fetch: fetch as unknown as typeof globalThis.fetch, now: clock.now, timers: clock.timers, log, ownerGrant },
  )
  if (!grant) throw new Error("the grant did not build")
  const renewed = async (operations: readonly ("read" | "create" | "start")[]) => {
    const next = await mintTasksCapability({ ...scope, operations }, signing, { now: clock.now, ttlSeconds: TTL_MS / 1_000 })
    return { body: { token: next.token, operations, expiresAt: next.expiresAt }, token: next.token }
  }
  const authorizationSent = async () => {
    await grant.fetch("/api/claxedo/tasks/tasks?projectId=project-a")
    const request = fetch.mock.calls.at(-1)?.[0] as Request
    return request.headers.get("authorization")
  }
  return { grant, clock, fetch, log, minted, renewed, authorizationSent, ownerGrant }
}

describe("the Tasks grant a cloud root is launched with", () => {
  test("reaches the control plane the runtime already answers to, as the capability", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    try {
      const grant = workspaceRuntimeTasksGrant(env())
      expect(grant?.operations).toEqual(["read", "create"])
      expect(grant?.projectId).toBe("project-a")
      await grant?.fetch("/api/claxedo/tasks/tasks?projectId=project-a")
      const request = fetch.mock.calls[0]?.[0] as Request | undefined
      expect(request?.url).toBe("https://plane.test/api/claxedo/tasks/tasks?projectId=project-a")
      expect(request?.headers.get("authorization")).toBe("Bearer capability-token")
    } finally {
      fetch.mockRestore()
    }
  })

  test("replaces an authorization a caller tried to set itself", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    try {
      const grant = workspaceRuntimeTasksGrant(env())
      await grant?.fetch("/api/claxedo/tasks/tasks", { headers: { authorization: "Bearer something-else" } })
      const request = fetch.mock.calls[0]?.[0] as Request | undefined
      expect(request?.headers.get("authorization")).toBe("Bearer capability-token")
    } finally {
      fetch.mockRestore()
    }
  })

  test("is absent without a capability, without a control plane, or with nothing granted", () => {
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_TASKS_CAPABILITY: "" }))).toBeUndefined()
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "" }))).toBeUndefined()
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_TASKS_OPERATIONS: "" }))).toBeUndefined()
  })

  test("drops an operation this build does not have", () => {
    expect(workspaceRuntimeTasksGrant(env({ WORKSPACE_RUNTIME_TASKS_OPERATIONS: "read,delete,start" }))?.operations)
      .toEqual(["read", "start"])
  })
})

describe("renewing the grant while the root runs", () => {
  test("asks for a renewal at half-life, swaps the token and operations in place, and schedules the next at the new half-life", async () => {
    let issued: Awaited<ReturnType<Awaited<ReturnType<typeof renewingRuntime>>["renewed"]>> | undefined
    const runtime = await renewingRuntime(async (request) => {
      expect(request.method).toBe("POST")
      expect(request.headers.get("authorization")).toBe(`Bearer ${runtime.minted.token}`)
      issued = await runtime.renewed(["read", "create", "start"])
      return Response.json(issued.body)
    })
    runtime.grant.start()
    expect(runtime.clock.pending()).toEqual([TTL_MS / 2])
    expect(runtime.grant.expiresAt).toBe(START + TTL_MS)

    await runtime.clock.advance(TTL_MS / 2)
    expect(runtime.fetch).toHaveBeenCalledTimes(1)
    expect(runtime.grant.operations).toEqual(["read", "create", "start"])
    expect(runtime.grant.expiresAt).toBe(START + TTL_MS / 2 + TTL_MS)
    expect(await runtime.authorizationSent()).toBe(`Bearer ${issued?.token}`)
    expect(runtime.clock.pending()).toEqual([TTL_MS / 2])
    expect(runtime.log.info).toHaveBeenCalledWith("tasks.grant.renewed", expect.objectContaining({ operations: ["read", "create", "start"] }))
    expect(runtime.grant.state).toEqual({ kind: "active" })
  })

  test("hands a renewed owner grant to its holder, and leaves the holder alone when the plane sent none", async () => {
    let issued = 0
    const runtime = await renewingRuntime(async () => {
      issued += 1
      const body = (await runtime.renewed(["read", "create"])).body
      return Response.json(issued === 1 ? { ...body, ownerGrant: { token: "owner-grant-2", expiresAt: runtime.clock.now() + TTL_MS } } : body)
    })
    runtime.grant.start()
    await runtime.clock.advance(TTL_MS / 2)
    expect(runtime.ownerGrant.swap).toHaveBeenCalledWith("owner-grant-2")
    await runtime.clock.advance(TTL_MS / 2)
    expect(issued).toBe(2)
    expect(runtime.ownerGrant.swap).toHaveBeenCalledTimes(1)
  })

  test("retries with doubling backoff, capped at a minute, until a renewal lands", async () => {
    const runtime = await renewingRuntime(async (_request, attempt) => {
      if (attempt <= 7) return new Response(null, { status: 503 })
      return Response.json((await runtime.renewed(["read", "create"])).body)
    })
    runtime.grant.start()
    await runtime.clock.advance(TTL_MS / 2)
    const delays: number[] = []
    while (runtime.fetch.mock.calls.length < 8) {
      const [delay] = runtime.clock.pending()
      if (delay === undefined) throw new Error("no retry was scheduled")
      delays.push(delay)
      await runtime.clock.advance(delay)
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
    expect(runtime.grant.state).toEqual({ kind: "active" })
    expect(runtime.grant.expiresAt).toBeGreaterThan(START + TTL_MS)
  })

  test("lapses at expiry when the control plane never answers: requests are refused here, and new sessions get no grant", async () => {
    const runtime = await renewingRuntime(async () => { throw new TypeError("fetch failed") })
    runtime.grant.start()
    expect(runtime.grant.current()).toBe(runtime.grant)
    await runtime.clock.advance(TTL_MS - 1)
    expect(runtime.grant.state).toEqual({ kind: "active" })
    expect(runtime.grant.current()).toBe(runtime.grant)
    const attempts = runtime.fetch.mock.calls.length
    expect(attempts).toBeGreaterThan(10)

    await runtime.clock.advance(1)
    expect(runtime.grant.state).toEqual({ kind: "lapsed" })
    expect(runtime.grant.current()).toBeUndefined()
    expect(runtime.clock.pending()).toEqual([])
    expect(runtime.log.warn).toHaveBeenCalledWith("tasks.grant.lapsed", expect.anything())

    const answer = await runtime.grant.fetch("/api/claxedo/tasks/tasks?projectId=project-a")
    expect(answer.status).toBe(503)
    expect(await answer.json()).toEqual({
      error: {
        code: "tasks_grant_lapsed",
        message: "This machine's Tasks grant has expired and could not be renewed; it is re-issued the next time the machine is provisioned.",
      },
    })
    expect(runtime.fetch.mock.calls.length).toBe(attempts)
  })

  test("a refusal withdraws the grant: renewal stops, the token serves until its expiry, then the refusal's own sentence answers", async () => {
    const runtime = await renewingRuntime(() =>
      Response.json({ error: { code: "tasks_group_disabled", message: "Tasks was turned off for this project." } }, { status: 403 }),
    )
    runtime.grant.start()
    await runtime.clock.advance(TTL_MS / 2)
    expect(runtime.grant.state).toEqual({ kind: "withdrawn", code: "tasks_group_disabled", message: "Tasks was turned off for this project." })
    expect(runtime.clock.pending()).toEqual([])
    expect(await runtime.authorizationSent()).toBe(`Bearer ${runtime.minted.token}`)
    expect(runtime.grant.current()).toBe(runtime.grant)

    await runtime.clock.advance(TTL_MS / 2)
    const answer = await runtime.grant.fetch("/api/claxedo/tasks/tasks?projectId=project-a")
    expect(answer.status).toBe(503)
    expect(await answer.json()).toEqual({ error: { code: "tasks_grant_withdrawn", message: "Tasks was turned off for this project." } })
    expect(runtime.grant.current()).toBeUndefined()
  })

  test("an owner-changed refusal is withdrawn the same way, and a 401 is a withdrawal too", async () => {
    const reowned = await renewingRuntime(() =>
      Response.json({ error: { code: "tasks_grant_owner_changed", message: "This session's workspace no longer answers for the grant it carries" } }, { status: 403 }),
    )
    reowned.grant.start()
    await reowned.clock.advance(TTL_MS / 2)
    expect(reowned.grant.state).toMatchObject({ kind: "withdrawn", code: "tasks_grant_owner_changed" })

    const revoked = await renewingRuntime(() => Response.json({ error: { code: "tasks_grant_invalid", message: "This Tasks capability cannot be renewed" } }, { status: 401 }))
    revoked.grant.start()
    await revoked.clock.advance(TTL_MS / 2)
    expect(revoked.grant.state).toMatchObject({ kind: "withdrawn", code: "tasks_grant_invalid" })
    expect(revoked.clock.pending()).toEqual([])
  })

  test("a token that is not a JWT has no lifetime this runtime can read, so nothing is scheduled and nothing lapses", async () => {
    const clock = fakeClock()
    const grant = workspaceRuntimeTasksGrant(env(), { now: clock.now, timers: clock.timers, log: { info: vi.fn(), warn: vi.fn() } })
    grant?.start()
    expect(clock.pending()).toEqual([])
    expect(grant?.expiresAt).toBeUndefined()
    await clock.advance(24 * 60 * 60_000)
    expect(grant?.state).toEqual({ kind: "active" })
    expect(grant?.current()).toBe(grant)
  })
})
