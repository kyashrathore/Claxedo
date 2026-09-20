import { afterEach, describe, expect, test } from "vitest"
import { configureAgentConfig, disposeAgentConfig, projectRuntimeAuth } from "@claxedo/server-core/agent-config/index"
import { hostProviderConfigProjectAuth } from "@claxedo/server-core/credentials/host-provider-config"

import { HostProviderConfigRoutes } from "./host-provider-config-routes"
import { clearHostProviderConfig, hostProviderConfig, hostProviderConfigState } from "./host-provider-config"

const PUSHED = { baseUrl: "https://broker.owner.test/bindings/b1", placeholder: "sk-owner-placeholder", authMode: "api-key" as const }
const MACHINE = { baseUrl: "http://127.0.0.1/bindings/local", placeholder: "sk-machine", authMode: "api-key" as const }

/** The sealed payload's plaintext, exactly as the control plane serialized it and the child opened it. */
const opened = (providers: Record<string, unknown>) => JSON.stringify({ version: 1, providers })

async function put(body: unknown) {
  return HostProviderConfigRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("the host provider-config route", () => {
  afterEach(() => {
    clearHostProviderConfig()
    disposeAgentConfig()
  })

  test("a pushed revision installs rows that the runtime's credential authority then answers with", async () => {
    configureAgentConfig({
      projectAuth: hostProviderConfigProjectAuth(async () => ({ "claude-sdk": MACHINE, codex: MACHINE }), hostProviderConfig),
    })
    expect(await projectRuntimeAuth({ scope: "local", workspaceId: "ws_1" })).toEqual({ "claude-sdk": MACHINE, codex: MACHINE })

    const response = await put({ revision: 3, providers: opened({ "claude-sdk": PUSHED }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 3, providerCount: 1 })
    expect(await projectRuntimeAuth({ scope: "local", workspaceId: "ws_1" })).toEqual({ "claude-sdk": PUSHED, codex: MACHINE })
  })

  test("reports the held revision whether or not one was pushed", async () => {
    expect(await (await HostProviderConfigRoutes().request("/")).json()).toEqual({ revision: null, providerCount: 0 })
    await put({ revision: 2, providers: opened({ "claude-sdk": PUSHED, codex: PUSHED }) })
    expect(await (await HostProviderConfigRoutes().request("/")).json()).toEqual({ revision: 2, providerCount: 2 })
  })

  test("the withdrawal empties the held rows", async () => {
    await put({ revision: 2, providers: opened({ "claude-sdk": PUSHED }) })
    const response = await put({ revision: 3, providers: opened({}) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 3, providerCount: 0 })
    expect(hostProviderConfig()).toEqual({})
  })

  test("a push naming one unreadable row changes nothing", async () => {
    await put({ revision: 2, providers: opened({ "claude-sdk": PUSHED }) })

    const response = await put({
      revision: 3,
      providers: opened({ codex: PUSHED, "claude-sdk": { baseUrl: "https://x", authMode: "api-key" } }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "invalid_provider_config" } })
    expect(hostProviderConfig()).toEqual({ "claude-sdk": PUSHED })
    expect(hostProviderConfigState()).toEqual({ revision: 2, providerCount: 1 })
  })

  test("a revision below the held one is refused whole; the same revision re-installs so main's re-push is a no-op", async () => {
    await put({ revision: 4, providers: opened({ "claude-sdk": PUSHED }) })

    const rolledBack = await put({ revision: 3, providers: opened({ codex: MACHINE }) })

    expect(rolledBack.status).toBe(409)
    expect(await rolledBack.json()).toMatchObject({ error: { code: "provider_config_revision_stale" } })
    expect(hostProviderConfig()).toEqual({ "claude-sdk": PUSHED })
    expect(hostProviderConfigState()).toEqual({ revision: 4, providerCount: 1 })

    const again = await put({ revision: 4, providers: opened({ "claude-sdk": PUSHED }) })
    expect(again.status).toBe(200)
    expect(hostProviderConfigState()).toEqual({ revision: 4, providerCount: 1 })

    // A restart holds nothing, so main's push of the revision it stored lands.
    clearHostProviderConfig()
    expect((await put({ revision: 4, providers: opened({ "claude-sdk": PUSHED }) })).status).toBe(200)
    expect(hostProviderConfigState()).toEqual({ revision: 4, providerCount: 1 })
  })

  test("refuses a body that is not the producer's shape", async () => {
    for (const body of [
      { revision: 3 },
      { providers: opened({}) },
      { revision: "3", providers: opened({}) },
      { revision: -1, providers: opened({}) },
      { revision: 3, providers: { version: 1, providers: {} } },
      { revision: 3, providers: opened({}), sealed: "mseal1.a.b.c" },
      "text",
    ]) {
      const response = await put(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request_body" } })
    }
    expect(hostProviderConfigState()).toEqual({ revision: null, providerCount: 0 })
  })
})
