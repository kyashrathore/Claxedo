import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { afterEach, expect, test, vi } from "vitest"
import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { createDraftSessionStart } from "./draft-session-start"

const h = vi.hoisted(() => ({ read: vi.fn(), hold: vi.fn(() => () => {}) }))
vi.mock("@/platform/runtime/agent/agent-runtime-client", () => ({ createAgentRuntimeClient: () => ({ getSessionStart: h.read }) }))
vi.mock("@/platform/runtime/session-event-scope", () => ({ holdSessionEventScope: h.hold, setSessionEventLiveWorkspace: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const owner: AgentSessionStartBinding = { sessionId: "pending", workspaceId: "workspace", directory: "/repo", connectionId: "agent", operationId: "creation" }
function mount(serverUrl: string, onRecoveredCreated?: (binding: AgentSessionStartBinding) => void, route?: { search: () => string; replace: (search: string) => void; surface: string }, prepareRecoveredSession?: (binding: AgentSessionStartBinding, draftId: string) => Promise<void>) {
  const [draftId, setDraftId] = createSignal(route?.surface ?? "draft-a")
  let value!: ReturnType<typeof createDraftSessionStart>
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Probe = () => {
    value = createDraftSessionStart({ serverUrl, draftId, sessionId: () => "new", signedControlPlane: () => false, hostKind: () => "machine", onRecoveredCreated, prepareRecoveredSession, locationSearch: route?.search, replaceSearch: route?.replace })
    return <span>{value.binding()?.sessionId ?? "none"}</span>
  }
  const view = render(() => <QueryClientProvider client={client}><Probe /></QueryClientProvider>)
  return { value, setDraftId, view, client }
}

test("a starting draft survives reload as an owner reference and stays isolated from other drafts", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
  const url = `http://localhost:${30000 + Math.floor(Math.random() * 10000)}`
  const first = mount(url)
  first.value.update("draft-a", owner)
  await waitFor(() => expect(h.read).toHaveBeenCalled())
  await waitFor(() => expect(first.value.binding()).toEqual(owner))
  first.setDraftId("draft-b")
  await waitFor(() => expect(first.value.binding()).toBeUndefined())
  first.view.unmount(); first.client.clear()
  const reopened = mount(url)
  await waitFor(() => expect(reopened.value.binding()).toEqual(owner))
  expect(h.read).toHaveBeenCalledWith({ directory: "/repo", sessionID: "pending", signal: expect.any(AbortSignal) })
  expect(h.hold).toHaveBeenCalledWith("pending", "workspace:workspace")
  reopened.value.update("draft-a", undefined)
  await waitFor(() => expect(reopened.value.binding()).toBeUndefined())
})

test("failed starts clear the draft reference without recreating a session", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "failed", error: "Agent disconnected", createdAt: 1, updatedAt: 2 } })
  const current = mount(`http://localhost:${40000 + Math.floor(Math.random() * 10000)}`)
  current.value.update("draft-a", owner)
  await waitFor(() => expect(h.read).toHaveBeenCalled())
  await waitFor(() => expect(current.value.error()).toBe("Agent disconnected"))
  expect(current.value.binding()).toBeUndefined()
  current.setDraftId("draft-b")
  await waitFor(() => expect(current.value.error()).toBeUndefined())
})


test("mismatched server ownership cannot expose another draft interaction", async () => {
  h.read.mockResolvedValue({ data: { binding: { ...owner, operationId: "another-operation" }, status: "starting", createdAt: 1, updatedAt: 1 } })
  const current = mount(`http://localhost:${45000 + Math.floor(Math.random() * 10000)}`)
  current.value.update("draft-a", owner)
  await waitFor(() => expect(current.value.error()).toContain("does not match"))
  expect(current.value.binding()).toBeUndefined()
})


test("reload follows authoritative completion without submitting the lost draft prompt", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
  const url = `http://localhost:${55000 + Math.floor(Math.random() * 1000)}`
  const first = mount(url)
  first.value.update("draft-a", owner)
  await waitFor(() => expect(first.value.binding()).toEqual(owner))
  first.view.unmount(); first.client.clear()
  h.read.mockResolvedValue({ data: { binding: owner, status: "created", upstreamSessionId: "real-agent-session", createdAt: 1, updatedAt: 2 } })
  const navigate = vi.fn()
  const reopened = mount(url, navigate)
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(owner))
  expect(navigate).toHaveBeenCalledTimes(1)
  expect(reopened.value.pending()).toBe(false)
  expect(reopened.value.binding()).toBeUndefined()
})


test("a transport failure retains the owner and recovers later canonical completion", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
  const navigate = vi.fn()
  const current = mount(`http://localhost:${57000 + Math.floor(Math.random() * 1000)}`, navigate)
  current.value.update("draft-a", owner)
  await waitFor(() => expect(current.value.binding()).toEqual(owner))
  current.value.update("draft-a", undefined, "transport-failed")
  expect(current.value.pending()).toBe(true)
  h.read.mockResolvedValue({ data: { binding: owner, status: "created", upstreamSessionId: "agent", createdAt: 1, updatedAt: 2 } })
  await current.client.invalidateQueries()
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(owner))
  expect(current.value.pending()).toBe(false)
})


test("the actual submitting draft identity survives a route reload with a new pane surface", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
  const [search, replace] = createSignal("?existing=preserved")
  const url = `http://localhost:${59000 + Math.floor(Math.random() * 1000)}`
  const first = mount(url, undefined, { search, replace, surface: "original-pane" })
  first.value.update("original-pane", owner)
  await waitFor(() => expect(first.value.binding()).toEqual(owner))
  expect(search()).toBe("?existing=preserved&draftId=original-pane")
  first.view.unmount(); first.client.clear()
  const navigate = vi.fn()
  const reopened = mount(url, navigate, { search, replace, surface: "new-pane-after-reload" })
  await waitFor(() => expect(reopened.value.binding()).toEqual(owner))
  expect(reopened.value.draftId()).toBe("original-pane")
  h.read.mockResolvedValue({ data: { binding: owner, status: "created", upstreamSessionId: "agent", createdAt: 1, updatedAt: 2 } })
  await reopened.client.invalidateQueries()
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(owner))
  expect(search()).toBe("?existing=preserved")
  expect(reopened.value.draftId()).toBe("new-pane-after-reload")
  expect(reopened.value.pending()).toBe(false)
})


test("a lost create response recovers completion already observed while the request was live", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "created", upstreamSessionId: "agent", createdAt: 1, updatedAt: 2 } })
  const navigate = vi.fn()
  const current = mount(`http://localhost:${61000 + Math.floor(Math.random() * 1000)}`, navigate)
  current.value.update("draft-a", owner)
  await waitFor(() => expect(current.client.getQueryCache().getAll().some(query => query.state.status === "success")).toBe(true))
  expect(navigate).not.toHaveBeenCalled()
  current.value.update("draft-a", undefined, "transport-failed")
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(owner))
  expect(current.value.pending()).toBe(false)
})

for (const leave of ["unmount", "switch-draft"] as const) {
  test(`a completion read after ${leave} cannot navigate or erase the durable owner`, async () => {
    h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
    const url = `http://localhost:${62000 + Math.floor(Math.random() * 1000)}`
    const first = mount(url)
    first.value.update("draft-a", owner)
    await waitFor(() => expect(first.value.binding()).toEqual(owner))
    first.view.unmount(); first.client.clear()
    let resolve!: (result: unknown) => void
    h.read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const navigate = vi.fn()
    const reopened = mount(url, navigate)
    await waitFor(() => expect(resolve).toBeTypeOf("function"))
    const signal = h.read.mock.calls.at(-1)![0].signal as AbortSignal
    if (leave === "unmount") reopened.view.unmount()
    else reopened.setDraftId("draft-b")
    await waitFor(() => expect(signal.aborted).toBe(true))
    resolve({ data: { binding: owner, status: "created", upstreamSessionId: "agent", createdAt: 1, updatedAt: 2 } })
    await Promise.resolve(); await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    if (leave !== "unmount") reopened.view.unmount()
    reopened.client.clear()
    h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
    const next = mount(url)
    await waitFor(() => expect(next.value.binding()).toEqual(owner))
  })
}


test("closing during recovered session preparation cannot navigate after preparation resolves", async () => {
  h.read.mockResolvedValue({ data: { binding: owner, status: "starting", createdAt: 1, updatedAt: 1 } })
  const url = `http://localhost:${63000 + Math.floor(Math.random() * 1000)}`
  const first = mount(url)
  first.value.update("draft-a", owner)
  await waitFor(() => expect(first.value.binding()).toEqual(owner))
  first.view.unmount(); first.client.clear()
  h.read.mockResolvedValue({ data: { binding: owner, status: "created", upstreamSessionId: "agent", createdAt: 1, updatedAt: 2 } })
  let finish!: () => void
  const prepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const navigate = vi.fn()
  const reopened = mount(url, navigate, undefined, prepare)
  await waitFor(() => expect(prepare).toHaveBeenCalledWith(owner, "draft-a"))
  reopened.view.unmount()
  finish()
  await Promise.resolve(); await Promise.resolve()
  expect(navigate).not.toHaveBeenCalled()
  reopened.client.clear()
  const next = mount(url, navigate)
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(owner))
  expect(next.value.pending()).toBe(false)
})
