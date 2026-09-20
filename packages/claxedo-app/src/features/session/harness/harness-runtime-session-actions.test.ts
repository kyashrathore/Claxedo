import { harnessWorkspaceRuntimeRef } from "./store-policy"
import { describe, expect, test } from "bun:test"
import { createHarnessRuntimeSessionActions } from "./harness-runtime-session-actions"
import type { HarnessScopeInput } from "./store-policy"
import { connectionHarness } from "@/platform/identity/harness-selection"
import { requestUrl } from "@/lib/url"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"


const sessionConfig = {
  agent: "build",
  model: { providerID: "claude-sdk", modelID: "sonnet" },
  variant: "high",
}

const canonicalSession = {
  id: "ses_created",
}

describe("harness runtime session actions", () => {
  test("creates prepared sessions through the explicit runtime transport with canonical config", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const actions = createHarnessRuntimeSessionActions({
      base: "http://127.0.0.1:3001",
      runtime: runtime({
        sessionFetch: async (resource, init) => {
          requests.push({
            url: requestUrl(resource),
            method: init?.method ?? "GET",
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          })
          return Response.json(canonicalSession)
        },
      }),
    })

    await expect(actions.create({
      input: { directory: "/repo", sessionConfig },
      directory: "/repo",
      harness: connectionHarness("claude-agent"),
    })).resolves.toBe("ses_created")

    expect(requests).toEqual([{
      url: "http://127.0.0.1:3001/session?directory=%2Frepo&connectionId=claude-agent",
      method: "POST",
      body: {
        agent: "build",
        model: { providerID: "claude-sdk", modelID: "sonnet" },
        variant: "high",
      },
    }])
  })

  test("skips delete outside local config or workspace runtime scopes", async () => {
    let clients = 0
    const actions = createHarnessRuntimeSessionActions({
      base: "https://claxedo.example.test",
      runtime: runtime({ useLocal: false }),
      createClient: () => {
        clients += 1
        return client()
      },
    })

    await actions.remove({
      id: "ses_prepared",
      directory: "/repo",
      harness: connectionHarness("claude-agent"),
      model: "sonnet",
    })

    expect(clients).toBe(0)
  })

  test("rejects the legacy SDK response envelope", async () => {
    const actions = createHarnessRuntimeSessionActions({
      base: "http://127.0.0.1:3001",
      runtime: runtime({
        sessionFetch: async () => Response.json({ data: { id: "ses_legacy" } }),
      }),
    })

    await expect(actions.create({
      input: { directory: "/repo", sessionConfig },
      directory: "/repo",
      harness: connectionHarness("claude-agent"),
    })).rejects.toMatchObject({ status: 502, code: "invalid_response" })
  })

  test("deletes eligible prepared sessions and propagates runtime failures", async () => {
    const requests: Array<{ url: string; method: string }> = []
    const actions = createHarnessRuntimeSessionActions({
      base: "http://127.0.0.1:3001",
      runtime: runtime({
        sessionFetch: async (resource, init) => {
          requests.push({ url: requestUrl(resource), method: init?.method ?? "GET" })
          return Response.json(
            { error: { code: "delete_failed", message: "Session is still running" } },
            { status: 409 },
          )
        },
      }),
    })

    await expect(actions.remove({
      id: "ses_local",
      directory: "/repo",
      harness: connectionHarness("claude-agent"),
      model: "sonnet",
    })).rejects.toMatchObject({ status: 409, code: "delete_failed" })

    expect(requests).toEqual([{
      url: "http://127.0.0.1:3001/session/ses_local?directory=%2Frepo",
      method: "DELETE",
    }])
  })

  test("deletes workspace-runtime prepared sessions through the scoped request", async () => {
    const deletes: string[] = []
    const actions = createHarnessRuntimeSessionActions({
      base: "https://claxedo.example.test",
      runtime: runtime({ useLocal: false }),
      createClient: () => client({
        deleteSession: async (input) => {
          deletes.push(input.sessionID)
          return { ok: true }
        },
      }),
    })

    await actions.remove({
      id: "ses_workspace",
      directory: "workspace:ws_1",
      harness: connectionHarness("codex-agent"),
      model: "gpt-5.5",
    })

    expect(deletes).toEqual(["ses_workspace"])
  })

  test("applies the workspace relay prefix exactly once", async () => {
    const urls: string[] = []
    const request: typeof fetch = async (resource) => {
      urls.push(requestUrl(resource))
      return Response.json(canonicalSession)
    }
    const actions = createHarnessRuntimeSessionActions({
      base: "http://127.0.0.1:3001",
      runtime: runtime({
        useLocal: false,
        clientOptions: () => ({
          request,
          workspaceId: "ws_1",
          hostKind: "provisioner",
        }),
      }),
    })

    await expect(actions.create({
      input: { directory: "workspace:ws_1", sessionConfig },
      directory: "workspace:ws_1",
      harness: connectionHarness("external-opencode"),
    })).resolves.toBe("ses_created")

    expect(urls).toEqual([
      "http://127.0.0.1:3001/workspaces/ws_1/session?connectionId=external-opencode",
    ])
  })
})

function client(overrides: {
  deleteSession?: (input: { directory: string; sessionID: string }) => Promise<{ ok: true }>
} = {}) {
  return {
    createSession: async () => ({ data: canonicalSession }),
    deleteSession: overrides.deleteSession ?? successfulDelete,
  }
}

async function successfulDelete(): Promise<{ ok: true }> {
  return { ok: true }
}

function runtime(input: {
  useLocal?: boolean | ((input?: HarnessScopeInput) => boolean)
  sessionFetch?: typeof fetch
  clientOptions?: (input?: HarnessScopeInput) => {
    request: typeof fetch
    workspaceId?: string
    hostKind?: RelayHostKind
  }
} = {}) {
  return {
    useLocalHarnessConfig: (params?: HarnessScopeInput) =>
      typeof input.useLocal === "function" ? input.useLocal(params) : input.useLocal ?? true,
    harnessSessionFetch: () => input.sessionFetch ?? fetch,
    workspaceRef: (params?: HarnessScopeInput) => harnessWorkspaceRuntimeRef(params),
    agentRuntimeClientOptions: (params?: HarnessScopeInput) => input.clientOptions?.(params) ?? { request: input.sessionFetch ?? fetch },
  }
}
