import { afterEach, describe, expect, test } from "bun:test"
import { createAgentConfigAccountFetch } from "./agent-config-account-fetch"
import { createControlPlaneAccountFetch } from "./control-plane-account-fetch"
import { createDocumentsAccountFetch } from "./documents-account-fetch"
import { createIntegrationsRequest } from "./integrations-request"

const originalApi = (globalThis as { api?: unknown }).api

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as { api?: unknown }).api
  else (globalThis as { api?: unknown }).api = originalApi
})

function bridgeThatDisappearsAfterAvailabilityCheck() {
  const account = {
    run: async () => {
      throw new Error("run should not be reached after bridge removal")
    },
    state: async () => ({ status: "signed" }),
    onState: () => () => undefined,
    signIn: async () => ({ status: "signed" }),
    signOut: async () => ({ status: "unsigned" }),
  }
  let reads = 0
  const api = {}
  Object.defineProperty(api, "account", {
    enumerable: true,
    get: () => (++reads === 1 ? account : undefined),
  })
  ;(globalThis as { api?: unknown }).api = api
}

async function expectBridgeUnavailable(response: Response) {
  expect(response.status).toBe(500)
  await expect(response.json()).resolves.toEqual({ error: { message: "account bridge unavailable" } })
}

function recordingAccountBridge() {
  const calls: Array<{ operation: string; input?: Record<string, unknown> }> = []
  ;(globalThis as { api?: unknown }).api = {
    account: {
      run: async (operation: string, input?: Record<string, unknown>) => {
        calls.push({ operation, input })
        return { ok: true }
      },
      state: async () => ({ status: "signed" }),
      onState: () => () => undefined,
      signIn: async () => ({ status: "signed" }),
      signOut: async () => ({ status: "unsigned" }),
    },
  }
  return calls
}

describe("AccountPort fetch adapters", () => {
  test("preserves the caught bridge-unavailable response after the initial availability check", async () => {
    bridgeThatDisappearsAfterAvailabilityCheck()
    await expectBridgeUnavailable(await createAgentConfigAccountFetch(
      async () => new Response("fallback"),
      "https://control.example.test",
    )("https://control.example.test/api/claxedo/agent-config/extensions"))

    bridgeThatDisappearsAfterAvailabilityCheck()
    await expectBridgeUnavailable(await createControlPlaneAccountFetch(
      async () => new Response("fallback"),
    )("https://control.example.test/api/control/sessions"))

    bridgeThatDisappearsAfterAvailabilityCheck()
    await expectBridgeUnavailable(await createDocumentsAccountFetch("https://control.example.test")(
      "https://control.example.test/documents/doc_1/work-source",
      { method: "POST", body: "{}" },
    ))
  })

  test("keeps the integrations adapter's distinct error envelope", async () => {
    bridgeThatDisappearsAfterAvailabilityCheck()

    const response = await createIntegrationsRequest("https://control.example.test")("/")

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ message: "account bridge unavailable" })
  })

  test("preserves session.create JSON bodies for Request and URL/init fetch styles", async () => {
    const calls = recordingAccountBridge()
    const request = createControlPlaneAccountFetch(async () => new Response("fallback"))
    const url = "https://control.example.test/api/control/sessions"

    await request(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "/repo/request", workspaceId: "ws_request" }),
    }))
    await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "/repo/init", workspaceId: "ws_init" }),
    })

    expect(calls).toEqual([
      {
        operation: "session.create",
        input: { directory: "/repo/request", workspaceId: "ws_request" },
      },
      {
        operation: "session.create",
        input: { directory: "/repo/init", workspaceId: "ws_init" },
      },
    ])
  })

  test("preserves projection JSON bodies for Request and URL/init fetch styles", async () => {
    const calls = recordingAccountBridge()
    const request = createControlPlaneAccountFetch(async () => new Response("fallback"))
    const actions = ["register", "checkpoint", "repair"] as const

    for (const action of actions) {
      const url = `https://control.example.test/api/control/workspaces/ws_1/sessions/ses_1/${action}`
      await request(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: `${action}-request`, reason: "request" }),
      }))
      await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: `${action}-init`, reason: "init" }),
      })
    }

    expect(calls).toEqual(actions.flatMap((action) => [
      {
        operation: `session.projection.${action}`,
        input: {
          workspaceId: "ws_1",
          sessionId: "ses_1",
          idempotencyKey: `${action}-request`,
          reason: "request",
        },
      },
      {
        operation: `session.projection.${action}`,
        input: {
          workspaceId: "ws_1",
          sessionId: "ses_1",
          idempotencyKey: `${action}-init`,
          reason: "init",
        },
      },
    ]))
  })
})
