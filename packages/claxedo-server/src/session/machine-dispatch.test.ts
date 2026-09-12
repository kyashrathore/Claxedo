import { beforeEach, describe, expect, test, vi } from "vitest"
import { createMachineSessionDispatch } from "./machine-dispatch"
import type { ControlPlaneServices } from "../authority/services"

const mock = vi.hoisted(() => ({
  workspace: { id: "ws", kind: "local", directory: "/repo" },
  request: vi.fn(),
  client: vi.fn(),
}))
vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: async ({ workspaceId }: { workspaceId: string }) =>
    workspaceId === "ws" ? mock.workspace : undefined,
}))
vi.mock("@claxedo/server-core/workspace/http/workspace-runtime-client", () => ({
  createWorkspaceRuntimeClient: (input: unknown) => {
    mock.client(input)
    return { request: mock.request }
  },
  workspaceRuntimeRequestError: async (_operation: string, response: Response) =>
    new Error(`runtime rejected ${response.status}`),
}))
const identity = { channel: "telegram", externalUserId: "external", threadKey: "telegram:chat:thread" }
const caller = { kind: "channel" as const, identity }
const actor = {
  actorId: "canonical-actor",
  actorKind: "human" as const,
  actorPublicId: "user-public",
  actorName: "Test User",
  orgId: "org",
  role: "editor" as const,
}
function fixture() {
  const authority = {
    resolveChannelMachineAccess: vi.fn(async () => actor),
    authorizeRuntimeSession: vi.fn(async () => {}),
    reserveSession: vi.fn(),
    reserveRuntimeSession: vi.fn(async (_principal, input) => ({ ...input, state: "reserved" })),
  }
  const projectionStore = {
    session_meta: vi.fn(async () => ({ host: "workspace", workspaceID: "ws" })),
    put_session_meta: vi.fn(async () => {}),
  }
  return {
    authority,
    projectionStore,
    runtime: createMachineSessionDispatch({ authority, projectionStore } as unknown as ControlPlaneServices, {}),
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.request.mockImplementation(async (_path, init) => {
    const body = JSON.parse(init.body)
    return Response.json({ id: body.id, directory: "/repo", title: "Native Pi" })
  })
})
describe("machine session dispatch", () => {
  test("reserves a channel session for its canonical actor and passes the receipt to the machine", async () => {
    const f = fixture()
    const session = await f.runtime.create({ workspaceId: "ws", harness: { id: "pi", access: "native" } }, caller)
    expect(f.authority.resolveChannelMachineAccess).toHaveBeenCalledWith(identity, "ws")
    expect(f.authority.reserveRuntimeSession).toHaveBeenCalledWith(
      { actorId: actor.actorId, actorKind: "human", principalKind: "user" },
      expect.objectContaining({ sessionId: session.id, workspaceId: "ws" }),
    )
    const [url, init] = mock.request.mock.calls[0]
    expect(url).toBe("/session?nativeHarness=pi")
    expect(init.headers["x-claxedo-session-registration-operation"]).toBe(
      f.authority.reserveRuntimeSession.mock.calls[0][1].operationId,
    )
    expect(mock.client.mock.calls[0][0].options).toMatchObject({
      channelIdentity: identity,
      runtimeActor: { actorId: actor.actorId },
      role: "editor",
    })
    expect(f.projectionStore.put_session_meta).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ host: "workspace", workspaceID: "ws", tags: ["harness:pi"] }),
    )
  })
  test("carries instructions and effort to the machine create", async () => {
    const f = fixture()
    const session = await f.runtime.create({
      workspaceId: "ws",
      harness: { id: "pi", access: "native" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "high",
      instructions: "Answer only in haiku.",
    }, caller)
    const [, init] = mock.request.mock.calls[0]
    expect(JSON.parse(init.body)).toMatchObject({
      id: session.id,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "high",
      instructions: "Answer only in haiku.",
    })
  })
  test("sends no instruction or effort field when the caller named neither", async () => {
    const f = fixture()
    await f.runtime.create({ workspaceId: "ws", harness: { id: "pi", access: "native" } }, caller)
    const [, init] = mock.request.mock.calls[0]
    expect(Object.keys(JSON.parse(init.body))).toEqual(["id"])
  })
  test("refuses unresolved machine targets before admission", async () => {
    const f = fixture()
    await expect(f.runtime.create({ workspaceId: "missing" }, caller)).rejects.toMatchObject({ status: 404 })
    expect(f.authority.reserveRuntimeSession).not.toHaveBeenCalled()
    expect(mock.request).not.toHaveBeenCalled()
  })
  test("rechecks channel binding and private session access before every operation", async () => {
    const f = fixture()
    mock.request.mockResolvedValue(Response.json({ ok: true }))
    await f.runtime.request("session", "abort", { method: "POST" }, caller)
    expect(f.authority.authorizeRuntimeSession).toHaveBeenCalledWith({
      actorId: actor.actorId,
      actorKind: "human",
      principalKind: "user",
      workspaceId: "ws",
      sessionId: "session",
      action: "write",
    })
    f.authority.resolveChannelMachineAccess.mockRejectedValueOnce(new Error("binding revoked"))
    await expect(f.runtime.request("session", "abort", { method: "POST" }, caller)).rejects.toThrow("binding revoked")
    expect(mock.request).toHaveBeenCalledTimes(1)
    f.authority.authorizeRuntimeSession.mockRejectedValueOnce(new Error("private session denied"))
    await expect(f.runtime.request("session", "abort", { method: "POST" }, caller)).rejects.toThrow(
      "private session denied",
    )
    expect(mock.request).toHaveBeenCalledTimes(1)
  })
  test("refuses mismatched registration and returned session identities", async () => {
    const f = fixture()
    f.authority.reserveRuntimeSession.mockImplementationOnce(async (_principal, input) => ({
      ...input,
      sessionId: "wrong",
      state: "reserved",
    }))
    await expect(f.runtime.create({ workspaceId: "ws" }, caller)).rejects.toThrow("reservation did not match")
    expect(mock.request).not.toHaveBeenCalled()
    mock.request.mockResolvedValueOnce(Response.json({ id: "wrong" }))
    await expect(f.runtime.create({ workspaceId: "ws" }, caller)).rejects.toThrow("invalid session identity")
    expect(f.projectionStore.put_session_meta).not.toHaveBeenCalled()
  })
})

describe("machine channel event ordering", () => {
  function streamFixture() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    let admit!: () => void
    const admitted = new Promise<void>((resolve) => {
      admit = resolve
    })
    mock.request.mockImplementation(async (url: string) => {
      if (url.startsWith("/event")) return new Response(stream)
      admit()
      return Response.json({ ok: true })
    })
    return {
      admitted,
      close: () => controller.close(),
      emit: (event: unknown) =>
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: event })}\r\n\r\n`)),
    }
  }
  const event = (type: string, properties: Record<string, unknown> = {}) => ({
    type,
    properties: { sessionID: "session", ...properties },
  })
  test("waits for the admitted turn's final events after HTTP completes, ignoring an older idle", async () => {
    const f = fixture()
    const s = streamFixture()
    const collected = (async () => {
      const events = []
      for await (const e of f.runtime.prompt("session", { messageID: "user-turn" }, caller)) events.push(e)
      return events
    })()
    await s.admitted
    s.emit(event("session.idle"))
    s.emit(event("message.updated", { info: { id: "user-turn", sessionID: "session", role: "user" } }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const final = event("message.part.updated", {
      part: { sessionID: "session", messageID: "reply", id: "part", type: "text", text: "Final reply" },
    })
    s.emit(final)
    s.emit(event("session.status", { status: { type: "idle" } }))
    expect(await collected).toEqual([
      event("message.updated", { info: { id: "user-turn", sessionID: "session", role: "user" } }),
      final,
      event("session.status", { status: { type: "idle" } }),
    ])
    expect(mock.request.mock.calls.filter(([url]) => url.endsWith("/message"))).toHaveLength(1)
  })
  test("reports a lost event stream instead of replaying or claiming completion", async () => {
    const f = fixture()
    const s = streamFixture()
    const collected = (async () => {
      for await (const _ of f.runtime.prompt("session", { messageID: "user-turn" }, caller)) {
      }
    })()
    const rejected = expect(collected).rejects.toThrow("disconnected during the turn")
    await s.admitted
    s.close()
    await rejected
    expect(mock.request.mock.calls.filter(([url]) => url.endsWith("/message"))).toHaveLength(1)
  })
})
