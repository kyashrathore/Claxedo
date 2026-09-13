import { afterEach, expect, test } from "bun:test"
import {
  applyCursorBackendUrl,
  CursorBackendUrlFrozenError,
  forgetCursorBackendUrl,
  freezeCursorBackendUrl,
  frozenCursorBackendUrl,
} from "./auth"
import { createCursorSdkDriver } from "./driver"
import type { SdkRuntimeDriverHost } from "../shared/sdk-runtime-driver"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"

/**
 * `@cursor/sdk@1.0.24` reads `CURSOR_BACKEND_URL` at module scope and offers no
 * per-agent option, so the value in force at the first import is the one every
 * local agent in this process uses. An agent created after that with a
 * different binding would send the placeholder to Cursor's own host — or the
 * machine's key to the broker.
 */
const BACKEND_URL = "CURSOR_BACKEND_URL"
const previous = process.env[BACKEND_URL]

afterEach(() => {
  forgetCursorBackendUrl()
  if (previous === undefined) delete process.env[BACKEND_URL]
  else process.env[BACKEND_URL] = previous
})

function host(): SdkRuntimeDriverHost {
  return {
    lifecycle: () => createSessionTurnLifecycle(), pendingPermissions: new Map(), pendingQuestions: new Map(),
    bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
    getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
    getSessionConfig: () => ({ harness: { id: "cursor", access: "native" } }),
    updatePermissionState() {},
  }
}

function projection(baseUrl: string) {
  return {
    "cursor-sdk": {
      baseUrl,
      placeholder: "cursor-placeholder",
      authMode: "bearer" as const,
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  }
}

test("the value in force at the import is what the SDK keeps", () => {
  process.env[BACKEND_URL] = "http://127.0.0.1:2595/bindings/first"
  freezeCursorBackendUrl()
  process.env[BACKEND_URL] = "http://127.0.0.1:2595/bindings/second"
  freezeCursorBackendUrl()

  expect(frozenCursorBackendUrl()).toMatchObject({ value: "http://127.0.0.1:2595/bindings/first" })
})

test("a binding applied after the SDK loaded refuses the turn instead of spending it elsewhere", async () => {
  // The SDK is loaded first, with no binding in force — exactly what happens
  // when anything in the process imports it before the config is applied.
  delete process.env[BACKEND_URL]
  freezeCursorBackendUrl()

  const driver = createCursorSdkDriver(host(), { loadSdk: async () => ({}) as never })
  await driver.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/late") })

  await expect(driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s1" }))
    .rejects.toBeInstanceOf(CursorBackendUrlFrozenError)
})

test("a binding the SDK was loaded under is used", async () => {
  applyCursorBackendUrl(projection("http://127.0.0.1:2595/bindings/ok")["cursor-sdk"])

  const created: unknown[] = []
  const driver = createCursorSdkDriver(host(), {
    loadAgent: async () => ({
      Agent: { create: async (options: unknown) => { created.push(options); return { id: "agent-1" } } },
    }) as never,
    loadSdk: async () => ({}) as never,
  })
  await driver.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/ok") })

  await driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s1" })

  expect(created).toHaveLength(1)
  expect((created[0] as { apiKey?: string }).apiKey).toBe("cursor-placeholder")
})

test("a process that never imported the SDK freezes nothing and refuses nothing", () => {
  expect(frozenCursorBackendUrl()).toBeUndefined()
})

test("the driver's own load is what freezes the value, with nobody calling the freeze", async () => {
  // The production call lives inside the driver's agent load. A test that
  // calls the freeze by hand proves the function, never the call.
  forgetCursorBackendUrl()
  applyCursorBackendUrl(projection("http://127.0.0.1:2595/bindings/loaded")["cursor-sdk"])
  const driver = createCursorSdkDriver(host(), {
    loadSdk: async () => ({}) as never,
  })
  await driver.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/loaded") })
  expect(frozenCursorBackendUrl()).toBeUndefined()

  await driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s1" }).catch(() => {})

  expect(frozenCursorBackendUrl()).toEqual({ value: "http://127.0.0.1:2595/bindings/loaded", binding: true })
})

test("a binding the SDK froze refuses a turn the operator has since unbound", async () => {
  // The other direction of the same fault: the SDK still points at the broker,
  // and an unbound turn would send the machine's own key there.
  applyCursorBackendUrl(projection("http://127.0.0.1:2595/bindings/gone")["cursor-sdk"])
  freezeCursorBackendUrl()
  applyCursorBackendUrl(undefined)

  const driver = createCursorSdkDriver(host(), { loadSdk: async () => ({}) as never })
  await driver.applyConfig({ auth: {} })

  await expect(driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s1" }))
    .rejects.toBeInstanceOf(CursorBackendUrlFrozenError)
})

test("an injected agent module freezes the value exactly as the real import does", async () => {
  // Five test files hand the driver a loaded module. A freeze that only ran on
  // the real import would leave every one of them running with the guard off.
  applyCursorBackendUrl(projection("http://127.0.0.1:2595/bindings/injected")["cursor-sdk"])
  const driver = createCursorSdkDriver(host(), {
    loadAgent: async () => ({ Agent: { create: async () => ({ id: "agent-1" }) } }) as never,
    loadSdk: async () => ({}) as never,
  })
  await driver.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/injected") })
  await driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s1" })

  await driver.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/switched") })

  expect(frozenCursorBackendUrl()).toEqual({ value: "http://127.0.0.1:2595/bindings/injected", binding: true })
  await expect(driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s2" }))
    .rejects.toBeInstanceOf(CursorBackendUrlFrozenError)
})

test("a second workspace's binding on the same broker is refused, not misrouted", async () => {
  // Two workspaces in one host mint two bindings on one loopback origin, and
  // the path is the binding id. The frozen value carries that path into every
  // request `@cursor/sdk@1.0.24` makes, so the second workspace's placeholder
  // would reach the first workspace's binding — which the broker answers with
  // `binding_not_permitted`. Refusing by name is what names the cause.
  applyCursorBackendUrl(projection("http://127.0.0.1:2595/bindings/workspace-a")["cursor-sdk"])
  const agentModule = { Agent: { create: async () => ({ id: "agent-1" }) } } as never
  const workspaceA = createCursorSdkDriver(host(), { loadAgent: async () => agentModule, loadSdk: async () => ({}) as never })
  await workspaceA.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/workspace-a") })
  await workspaceA.createAgentSession({ directory: "/a", model: "auto", sessionId: "a1" })

  const workspaceB = createCursorSdkDriver(host(), { loadAgent: async () => agentModule, loadSdk: async () => ({}) as never })
  await workspaceB.applyConfig({ auth: projection("http://127.0.0.1:2595/bindings/workspace-b") })

  await expect(workspaceB.createAgentSession({ directory: "/b", model: "auto", sessionId: "b1" }))
    .rejects.toThrow("http://127.0.0.1:2595/bindings/workspace-b")
})

test("a backend URL the operator set themselves is not a binding and refuses nothing", async () => {
  process.env[BACKEND_URL] = "https://cursor.proxy.internal"
  freezeCursorBackendUrl()

  const created: unknown[] = []
  const driver = createCursorSdkDriver(host(), {
    loadAgent: async () => ({
      Agent: { create: async (options: unknown) => { created.push(options); return { id: "agent-1" } } },
    }) as never,
    loadSdk: async () => ({}) as never,
  })
  await driver.applyConfig({ auth: {} })

  await driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "s1" })

  expect(created).toHaveLength(1)
})
