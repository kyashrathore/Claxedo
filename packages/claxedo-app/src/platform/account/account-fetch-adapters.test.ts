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
})
