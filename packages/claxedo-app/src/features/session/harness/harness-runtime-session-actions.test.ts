import { describe, expect, test } from "bun:test"
import { createHarnessRuntimeSessionActions } from "./harness-runtime-session-actions"
import type { HarnessScopeInput } from "./store-policy"
import type { PreparedRuntimeSessionConfig } from "./prepared-session"

type ClaimInput = HarnessScopeInput & { sessionConfig: PreparedRuntimeSessionConfig }

const sessionConfig = {
  agent: "build",
  model: { providerID: "claude-sdk", modelID: "sonnet" },
  variant: "high",
}

describe("harness runtime session actions", () => {
  test("creates prepared sessions through SDK fetch with harness routing", async () => {
    const fetchUrls: string[] = []
    const clients: ClientInput[] = []
    const creates: unknown[] = []
    const actions = createHarnessRuntimeSessionActions<ClaimInput>({
      base: "http://127.0.0.1:3001",
      runtime: runtime({
        sessionFetch: async (input) => {
          fetchUrls.push(String(input))
          return Response.json({})
        },
      }),
      createClient: (input) => {
        clients.push(input)
        return {
          session: {
            create: async (value) => {
              creates.push(value)
              await input.fetch("http://127.0.0.1:3001/session", { method: "POST" })
              return { data: { id: "ses_created" } }
            },
            delete: async () => undefined,
          },
        }
      },
    })

    await expect(
      actions.create({
        input: { directory: "/repo", sessionConfig },
        directory: "/repo",
        harness: "claude-acp",
      }),
    ).resolves.toBe("ses_created")

    expect(clients).toMatchObject([
      {
        baseUrl: "http://127.0.0.1:3001",
        directory: "/repo",
        throwOnError: true,
      },
    ])
    expect(fetchUrls).toEqual(["http://127.0.0.1:3001/session?harness=claude-acp"])
    expect(creates).toEqual([
      {
        directory: "/repo",
        agent: "build",
        model: { providerID: "claude-sdk", id: "sonnet", variant: "high" },
      },
    ])
  })

  test("skips delete outside local config or workspace runtime scopes", async () => {
    const deletes: string[] = []
    const actions = createHarnessRuntimeSessionActions<ClaimInput>({
      base: "https://claxedo.example.test",
      runtime: runtime({ useLocal: false }),
      createClient: () => ({
        session: {
          create: async () => ({ data: { id: "ses_created" } }),
          delete: async (input) => {
            deletes.push(input.sessionID)
          },
        },
      }),
    })

    await actions.remove({
      id: "ses_prepared",
      directory: "/repo",
      harness: "claude-acp",
      model: "sonnet",
    })

    expect(deletes).toEqual([])
  })

  test("returns undefined when create response has no id", async () => {
    const actions = createHarnessRuntimeSessionActions<ClaimInput>({
      base: "http://127.0.0.1:3001",
      runtime: runtime(),
      createClient: () => ({
        session: {
          create: async () => ({ data: {} }),
          delete: async () => undefined,
        },
      }),
    })

    await expect(
      actions.create({
        input: { directory: "/repo", sessionConfig },
        directory: "/repo",
        harness: "claude-acp",
      }),
    ).resolves.toBeUndefined()
  })

  test("deletes local and workspace runtime prepared sessions and swallows failures", async () => {
    const deletes: string[] = []
    const actions = createHarnessRuntimeSessionActions<ClaimInput>({
      base: "http://127.0.0.1:3001",
      runtime: runtime({ useLocal: (input) => input?.directory === "/repo" }),
      createClient: () => ({
        session: {
          create: async () => ({ data: { id: "ses_created" } }),
          delete: async (input) => {
            deletes.push(input.sessionID)
            throw new Error("already gone")
          },
        },
      }),
    })

    await actions.remove({
      id: "ses_local",
      directory: "/repo",
      harness: "claude-acp",
      model: "sonnet",
    })
    await actions.remove({
      id: "ses_workspace",
      directory: "workspace:ws_1",
      harness: "codex-acp",
      model: "gpt-5.5",
    })

    expect(deletes).toEqual(["ses_local", "ses_workspace"])
  })
})

type ClientInput = {
  baseUrl: string
  fetch: typeof fetch
  directory: string
  throwOnError?: boolean
}

function runtime(
  input: {
    useLocal?: boolean | ((input?: HarnessScopeInput) => boolean)
    sessionFetch?: typeof fetch
  } = {},
) {
  return {
    useLocalHarnessConfig: (params?: HarnessScopeInput) =>
      typeof input.useLocal === "function" ? input.useLocal(params) : (input.useLocal ?? true),
    harnessSessionFetch: () => input.sessionFetch ?? fetch,
  }
}
