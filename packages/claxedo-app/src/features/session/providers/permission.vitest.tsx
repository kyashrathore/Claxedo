import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { onCleanup } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentPermission } from "@claxedo/agent-runtime-contract"
import { PermissionProvider, usePermission } from "./permission"
import { acceptKey } from "./permission-auto-respond"
import { Persist, removePersisted, setPersisted } from "@/platform/persistence/persist"
import { shellDataKeys } from "@/platform/sync/keys"
import { queryClient } from "@/platform/query/query-client"

type AskedEvent = { name: string; details: { type: "permission.asked"; properties: AgentPermission } }
const transport = vi.hoisted(() => ({
  listeners: new Set<(event: AskedEvent) => void>(),
  list: vi.fn(),
  respond: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock("@/features/session/app-ports", () => ({
  useGlobalSDK: () => ({
    url: "https://control.test",
    createClient: transport.createClient,
    event: { listen: (listener: (event: AskedEvent) => void) => {
      transport.listeners.add(listener)
      return () => transport.listeners.delete(listener)
    } },
  }),
}))
vi.mock("@/platform/telemetry/analytics", () => ({ capture: vi.fn(), identityProps: () => ({}) }))

const DIRECTORY = "/work/explicit-approval"
const SESSION = "ses_permission"
const TARGET = Persist.global("permission")

function request(id: string, permission = "read", sessionID = SESSION): AgentPermission {
  return { id, sessionID, permission, patterns: [], always: [], metadata: {} }
}

function emit(permission: AgentPermission, directory = DIRECTORY) {
  for (const listener of transport.listeners) {
    listener({ name: directory, details: { type: "permission.asked", properties: permission } })
  }
}

async function mount() {
  let api: ReturnType<typeof usePermission> | undefined
  function Probe() {
    api = usePermission()
    onCleanup(api.observeDirectory(DIRECTORY))
    return <div />
  }
  const view = render(() => <PermissionProvider><Probe /></PermissionProvider>)
  await waitFor(() => expect(api?.ready()).toBe(true))
  if (!api) throw new Error("PermissionProvider did not mount")
  return { api, unmount: view.unmount }
}

beforeEach(() => {
  queryClient.clear()
  removePersisted(TARGET)
  localStorage.removeItem("permission.v3")
  transport.list.mockReset().mockResolvedValue({ data: [] })
  transport.respond.mockReset().mockResolvedValue({ data: { ok: true, events: [] } })
  transport.createClient.mockReset().mockImplementation(() => ({
    permission: { list: transport.list, respond: transport.respond },
  }))
})

afterEach(() => {
  cleanup()
  expect(transport.listeners.size).toBe(0)
  queryClient.clear()
  removePersisted(TARGET)
})

describe("explicit permission policy", () => {
  test("reconciles simultaneous pane directories without route params and releases each scope independently", async () => {
    const otherDirectory = "/work/second-pane"
    setPersisted(TARGET, { autoAccept: { [acceptKey(SESSION, otherDirectory)]: true } })
    const { api } = await mount()
    await waitFor(() => expect(api.requestPolicyReady(DIRECTORY)).toBe(true))
    let finish: (value: { data: AgentPermission[] }) => void = () => {}
    transport.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const release = api.observeDirectory(otherDirectory)
    const releaseSecond = api.observeDirectory(otherDirectory)
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2))
    expect(api.requestPolicyReady(otherDirectory)).toBe(false)
    expect(api.requestPolicyReady(DIRECTORY)).toBe(true)
    release()
    finish({ data: [] })
    await waitFor(() => expect(api.requestPolicyReady(otherDirectory)).toBe(true))
    releaseSecond()
    expect(api.requestPolicyReady(otherDirectory)).toBe(false)
    expect(api.requestPolicyReady(DIRECTORY)).toBe(true)

    transport.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const disposePending = api.observeDirectory(otherDirectory)
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3))
    disposePending()
    finish({ data: [request("disposed-pane")] })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.respond).not.toHaveBeenCalled()
  })

  test("cached engine allow rules cannot enable autoaccept or start an engine config read", async () => {
    queryClient.setQueryData(["directory", "https://control.test", "config", DIRECTORY, ""], {
      permission: "allow",
    })
    const { api } = await mount()
    await waitFor(() => expect(api.requestPolicyReady(DIRECTORY)).toBe(true))

    emit(request("manual"))
    expect(api.isAutoAccepting(SESSION, DIRECTORY)).toBe(false)
    expect(api.isAutoAcceptingDirectory(DIRECTORY)).toBe(false)
    expect(api.autoResponds(request("manual"), DIRECTORY)).toBe(false)
    expect(transport.createClient).not.toHaveBeenCalled()
    expect(transport.list).not.toHaveBeenCalled()
    expect(transport.respond).not.toHaveBeenCalled()
  })

  test("explicit session choice survives remount and answers only safe requests in its scope", async () => {
    const first = await mount()
    first.api.enableAutoAccept(SESSION, DIRECTORY)
    await waitFor(() => expect(transport.list).toHaveBeenCalled())
    expect(JSON.parse(localStorage.getItem(`${TARGET.storage}:${TARGET.key}`)!)).toEqual({
      autoAccept: { [acceptKey(SESSION, DIRECTORY)]: true },
    })
    first.unmount()
    queryClient.clear()
    transport.list.mockClear().mockResolvedValue({ data: [request("pending"), request("shell", "execute")] })
    const second = await mount()
    await waitFor(() => expect(second.api.requestPolicyReady(DIRECTORY)).toBe(true))
    await waitFor(() => expect(transport.respond).toHaveBeenCalledTimes(1))
    expect(transport.respond).toHaveBeenCalledWith({
      directory: DIRECTORY, sessionID: SESSION, permissionID: "pending", response: "once",
    })
    emit(request("pending"))
    emit(request("other-session", "read", "ses_other"))
    emit(request("other-workspace"), "/work/other")
    emit(request("dangerous", "execute"))
    expect(transport.respond).toHaveBeenCalledTimes(1)
    expect(second.api.autoResponds(request("shell", "execute"), DIRECTORY)).toBe(false)
    expect(second.api.isAutoAccepting(SESSION, "/work/other")).toBe(false)

    second.api.disableAutoAccept(SESSION, DIRECTORY)
    emit(request("disabled"))
    expect(transport.respond).toHaveBeenCalledTimes(1)
    second.unmount()
    const third = await mount()
    expect(third.api.isAutoAccepting(SESSION, DIRECTORY)).toBe(false)
  })

  test("manual approval and rejection preserve the response and only successful always enables policy", async () => {
    const { api } = await mount()
    for (const response of ["once", "reject"] as const) {
      await api.respond({ sessionID: SESSION, permissionID: response, response, directory: DIRECTORY })
      expect(transport.respond).toHaveBeenLastCalledWith({
        directory: DIRECTORY, sessionID: SESSION, permissionID: response, response,
      })
      expect(api.isAutoAccepting(SESSION, DIRECTORY)).toBe(false)
    }
    transport.respond.mockRejectedValueOnce(new Error("approval unavailable"))
    await expect(api.respond({ sessionID: SESSION, permissionID: "failed", response: "always", directory: DIRECTORY }))
      .rejects.toThrow("approval unavailable")
    expect(api.isAutoAccepting(SESSION, DIRECTORY)).toBe(false)
    expect(transport.list).not.toHaveBeenCalled()

    await api.respond({ sessionID: SESSION, permissionID: "approved", response: "always", directory: DIRECTORY })
    expect(api.isAutoAccepting(SESSION, DIRECTORY)).toBe(true)
    expect(transport.respond).toHaveBeenLastCalledWith({
      directory: DIRECTORY, sessionID: SESSION, permissionID: "approved", response: "always",
    })
  })

  test("failed automatic approval exposes the request for an explicit rejection", async () => {
    setPersisted(TARGET, { autoAccept: { [acceptKey(SESSION, DIRECTORY)]: true } })
    const { api } = await mount()
    await waitFor(() => expect(api.requestPolicyReady(DIRECTORY)).toBe(true))
    transport.respond.mockRejectedValueOnce(new Error("offline"))
    const permission = request("failed-auto")
    emit(permission)
    await waitFor(() => expect(api.autoResponds(permission, DIRECTORY)).toBe(false))
    expect(transport.respond).toHaveBeenCalledTimes(1)
    expect(transport.respond).toHaveBeenLastCalledWith({
      directory: DIRECTORY, sessionID: SESSION, permissionID: permission.id, response: "once",
    })
    await api.respond({ sessionID: SESSION, permissionID: permission.id, response: "reject", directory: DIRECTORY })
    expect(transport.respond).toHaveBeenLastCalledWith({
      directory: DIRECTORY, sessionID: SESSION, permissionID: permission.id, response: "reject",
    })
  })

  test("failed pending-list reconciliation leaves manual approvals usable", async () => {
    setPersisted(TARGET, { autoAccept: { [acceptKey(SESSION, DIRECTORY)]: true } })
    transport.list.mockRejectedValue(new Error("list unavailable"))
    const { api } = await mount()
    await waitFor(() => expect(api.requestPolicyReady(DIRECTORY)).toBe(true))
    expect(api.autoResponds(request("pending"), DIRECTORY)).toBe(false)
    expect(transport.respond).not.toHaveBeenCalled()
    await api.respond({ sessionID: SESSION, permissionID: "pending", response: "once", directory: DIRECTORY })
    expect(transport.respond).toHaveBeenCalledTimes(1)
  })
})

test("a successful response applies the runtime reply before resolving, without waiting for SSE", async () => {
  const permission = request("pending-http")
  queryClient.setQueryData(shellDataKeys.sessionId(SESSION, "requests"), {
    permissions: [permission], questions: [],
  })
  const { api } = await mount()
  transport.respond.mockResolvedValueOnce({ data: { ok: true, events: [{
    id: "event_permission_reply", type: "permission.replied", properties: { sessionID: SESSION, requestID: permission.id, reply: "once" },
  }] } })
  await api.respond({ sessionID: SESSION, permissionID: permission.id, response: "once", directory: DIRECTORY })
  expect(queryClient.getQueryData<{ permissions: AgentPermission[] }>(shellDataKeys.sessionId(SESSION, "requests"))?.permissions).toEqual([])
})

test("provider choice IDs cross the transport without enabling a guessed approval policy", async () => {
  const { api } = await mount()
  await api.respond({ sessionID: SESSION, permissionID: "provider-choice", response: { optionId: "remember/workspace" }, directory: DIRECTORY })
  expect(transport.respond).toHaveBeenLastCalledWith({ sessionID: SESSION, permissionID: "provider-choice", optionId: "remember/workspace", directory: DIRECTORY })
  expect(api.isAutoAccepting(SESSION, DIRECTORY)).toBe(false)
  api.enableAutoAccept(SESSION, DIRECTORY)
  await waitFor(() => expect(api.requestPolicyReady(DIRECTORY)).toBe(true))
  expect(api.autoResponds(request("legacy-read", "read"), DIRECTORY)).toBe(true)
  expect(api.autoResponds({ ...request("manual-provider", "read"), options: [{ id: "yes", label: "Yes" }] }, DIRECTORY)).toBe(false)
})
