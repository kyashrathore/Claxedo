import { describe, expect, test } from "bun:test"
import { AgentPluginRequestError, agentPluginApi, agentPluginMutationResult, agentPluginSkillResult, isAgentPluginRevisionConflict, withCurrentRevision } from "./api"

const activation = { effective: { status: "ready", effective: true, winner: "user-default" } }

const candidate = (overrides: Record<string, unknown> = {}) => ({
  pluginInstanceId: "[\"claxedo\",\"docs\"]",
  sourceId: "claxedo",
  sourceKind: "claxedo",
  source: { id: "claxedo", kind: "claxedo", label: "Claxedo", repository: "kyashrathore/plugins" },
  icon: { kind: "url", url: "https://cdn.example/docs.png" },
  skills: [{ name: "search", description: "Search the docs", path: "skills/search" }],
  sourceRevision: "main",
  relativePath: "docs",
  candidateDigest: "sha256:candidate",
  sourceAvailable: true,
  retainedDigest: null,
  updateAvailable: false,
  manifest: { name: "docs", version: "1.0.0" },
  componentDiagnostics: [],
  mcpServers: [],
  harnesses: { opencode: activation, claude: activation, codex: activation, cursor: activation },
  ...overrides,
})

const catalogBody = (...candidates: unknown[]) => ({
  revision: 7,
  supportedHarnesses: ["opencode", "claude", "codex", "cursor"],
  candidates,
  errors: [],
})

describe("Agent Plugins client", () => {
  test("Refresh is a read-only catalog query and activation carries optimistic revision", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json(init?.method === "POST"
        ? { revision: 8, reconciliation: { state: "applied" } }
        : { revision: 7, supportedHarnesses: [], candidates: [], errors: [] })
    }
    const api = agentPluginApi({ baseUrl: "http://127.0.0.1:2593", request })

    await api.catalog({ refresh: true, projectId: "project_1" })
    await api.activation({ pluginInstanceId: "source/plugin", harnessIds: ["codex"], choice: true, expectedRevision: 7 })

    expect(calls[0]?.url).toBe("http://127.0.0.1:2593/api/claxedo/plugins/projects/project_1/refresh")
    expect(calls[1]?.url).toBe("http://127.0.0.1:2593/api/claxedo/plugins/activation")
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      pluginInstanceId: "source/plugin",
      harnessIds: ["codex"],
      choice: true,
      expectedRevision: 7,
    })
  })

  test("surfaces the server's canonical error instead of synthesizing catalog state", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json({ error: { message: "revision changed" } }, { status: 409 }),
    })

    await expect(api.update({ pluginInstanceId: "source/plugin", expectedRevision: 1 })).rejects.toThrow("revision changed")
  })

  test("rejects successful responses that do not match the catalog contract", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json({ revision: 1, supportedHarnesses: ["imaginary"], candidates: [], errors: [] }),
    })

    await expect(api.catalog()).rejects.toThrow("did not match its API contract")
  })

  test("keeps a candidate's icon, skills, and named source", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json(catalogBody(candidate(), candidate({
        icon: { kind: "monogram", text: "CR" },
        skills: [],
        source: null,
      }))),
    })

    const catalog = await api.catalog()

    expect(catalog.candidates[0]).toMatchObject({
      icon: { kind: "url", url: "https://cdn.example/docs.png" },
      skills: [{ name: "search", description: "Search the docs", path: "skills/search" }],
      source: { id: "claxedo", kind: "claxedo", label: "Claxedo", repository: "kyashrathore/plugins" },
    })
    expect(catalog.candidates[1]).toMatchObject({ icon: { kind: "monogram", text: "CR" }, source: null })
  })

  test("rejects a candidate whose icon, skills, or source break the contract", async () => {
    const reject = async (overrides: Record<string, unknown>) => {
      const api = agentPluginApi({
        baseUrl: "https://claxedo.test",
        request: async () => Response.json(catalogBody(candidate(overrides))),
      })
      await expect(api.catalog()).rejects.toThrow("did not match its API contract")
    }

    await reject({ icon: { kind: "url", url: 42 } })
    await reject({ icon: { kind: "svg", markup: "<svg />" } })
    await reject({ skills: [{ name: "search", description: "Search the docs" }] })
    await reject({ source: { id: "claxedo", kind: "machine", label: "This machine" } })
  })

  test("reads one skill from the plugin's own route under the same project scope as the catalog", async () => {
    const calls: string[] = []
    const api = agentPluginApi({
      baseUrl: "http://127.0.0.1:2593",
      request: async (input) => {
        calls.push(String(input))
        return Response.json({ name: "search", description: "Search the docs", markdown: "# Search\n" })
      },
    })

    const document = await api.skill({ pluginInstanceId: "[\"claxedo\",\"docs\"]", skill: "search" })
    await api.skill({ pluginInstanceId: "[\"claxedo\",\"docs\"]", skill: "search", projectId: "project_1" })

    expect(document).toEqual({ name: "search", description: "Search the docs", markdown: "# Search\n" })
    expect(calls[0]).toBe("http://127.0.0.1:2593/api/claxedo/plugins/%5B%22claxedo%22%2C%22docs%22%5D/skills/search")
    expect(calls[1]).toBe("http://127.0.0.1:2593/api/claxedo/plugins/projects/project_1/%5B%22claxedo%22%2C%22docs%22%5D/skills/search")
  })

  test("decodes a hosted skill operation's status result and surfaces its error", () => {
    expect(agentPluginSkillResult({ status: 200, body: { name: "search", description: "d", markdown: "# S" } }))
      .toEqual({ name: "search", description: "d", markdown: "# S" })
    expect(() => agentPluginSkillResult({ status: 200, body: { name: "search", description: "d" } }))
      .toThrow("did not match its API contract")
    expect(() => agentPluginSkillResult({
      status: 404,
      body: { error: { code: "agent_plugins_skill_not_found", message: "No retained artifact serves this skill" } },
    })).toThrow("No retained artifact serves this skill")
  })

  test("rejects malformed mutation receipts", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json({ revision: 2, reconciliation: { state: 42 } }),
    })

    await expect(api.update({ pluginInstanceId: "source/plugin", expectedRevision: 1 })).rejects.toThrow("did not match its API contract")
  })
})

describe("withCurrentRevision", () => {
  test("a revision conflict re-reads the catalog and retries once with the fresh revision", async () => {
    let revision: number | undefined = 9
    const attempts: number[] = []
    const result = await withCurrentRevision({
      revision: () => revision,
      reread: async () => { revision = 11 },
      run: async (expectedRevision) => {
        attempts.push(expectedRevision)
        if (expectedRevision !== 11) {
          throw new AgentPluginRequestError(409, "agent_plugins_revision_conflict", `Agent plugin activation revision changed from ${expectedRevision} to 11`)
        }
        return { revision: 12 }
      },
    })
    expect(result).toEqual({ revision: 12 })
    expect(attempts).toEqual([9, 11])
  })

  test("a second conflict, an unchanged revision, and any other failure surface as-is", async () => {
    const conflict = (expected: number) => new AgentPluginRequestError(409, "agent_plugins_revision_conflict", `changed from ${expected}`)
    const twice: number[] = []
    await expect(withCurrentRevision({
      revision: () => 9 + twice.length * 2,
      reread: async () => undefined,
      run: async (expectedRevision) => { twice.push(expectedRevision); throw conflict(expectedRevision) },
    })).rejects.toThrow("changed from 11")
    expect(twice).toEqual([9, 11])

    const stuck: number[] = []
    await expect(withCurrentRevision({
      revision: () => 9,
      reread: async () => undefined,
      run: async (expectedRevision) => { stuck.push(expectedRevision); throw conflict(expectedRevision) },
    })).rejects.toThrow("changed from 9")
    expect(stuck).toEqual([9])

    const denied: number[] = []
    await expect(withCurrentRevision({
      revision: () => 9,
      reread: async () => { throw new Error("must not re-read") },
      run: async (expectedRevision) => { denied.push(expectedRevision); throw new AgentPluginRequestError(403, "workspace_authorization_denied", "denied") },
    })).rejects.toThrow("denied")
    expect(denied).toEqual([9])
  })

  test("a 409 answer becomes a request error the retry recognises", () => {
    expect(() => agentPluginMutationResult({ status: 409, body: { error: { code: "agent_plugins_revision_conflict", message: "moved" } } }))
      .toThrow(AgentPluginRequestError)
    try {
      agentPluginMutationResult({ status: 409, body: { error: { code: "agent_plugins_revision_conflict", message: "moved" } } })
    } catch (error) {
      expect(isAgentPluginRevisionConflict(error)).toBe(true)
      expect(error).toMatchObject({ status: 409, code: "agent_plugins_revision_conflict", message: "moved" })
    }
    expect(isAgentPluginRevisionConflict(new Error("moved"))).toBe(false)
  })
})
