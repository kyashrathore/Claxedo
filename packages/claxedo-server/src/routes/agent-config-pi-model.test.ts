import { afterAll, afterEach, describe, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(os.tmpdir(), `agent-config-pi-model-${randomUUID().slice(0, 8)}`)
const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  CLAXEDO_PI_MODEL_BACKEND: process.env.CLAXEDO_PI_MODEL_BACKEND,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
process.env.ANTHROPIC_API_KEY = "test-key"

const [{ createAgentConfigRoutes }, { putSessionMeta, sessionMeta }, { piProviderCatalog }, { ClaxedoDB }] = await Promise.all([
  import("./agent-config"),
  import("../session/meta/meta"),
  import("../pi-provider-catalog"),
  import("../adapters/storage/db"),
])

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("central Pi model selection", () => {
  test("persists and applies the complete model key", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("pi-session", { host: "central" })
    const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
    const update = vi.fn(async () => {})
    const messages: unknown[] = []
    const app = createAgentConfigRoutes({
      services: {
        projectionStore: {
          read_session_messages: () => messages,
          put_session_meta: putSessionMeta,
        },
      } as never,
      updateCentralSessionModel: update,
    })

    const res = await app.request("/harness/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "pi-session",
        model: { providerID: "anthropic", modelID },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, model: { providerID: "anthropic", modelID } })
    expect((await sessionMeta("pi-session"))?.model).toEqual({ providerID: "anthropic", modelID })
    expect(update).toHaveBeenCalledWith("pi-session", { providerID: "anthropic", modelID })
  })

  test("locks model mutation after the first persisted message", async () => {
    await fs.mkdir(root, { recursive: true })
    await putSessionMeta("started-pi", { host: "central" })
    const modelID = Object.keys(piProviderCatalog().all.find((provider) => provider.id === "anthropic")!.models)[0]!
    const app = createAgentConfigRoutes({
      services: {
        projectionStore: {
          read_session_messages: () => [{ info: { role: "user" }, parts: [] }],
          put_session_meta: putSessionMeta,
        },
      } as never,
    })

    const res = await app.request("/harness/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "started-pi", model: { providerID: "anthropic", modelID } }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "agent_config_session_model_locked" } })
  })
})
