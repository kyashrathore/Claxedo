import { describe, expect, test } from "bun:test"
import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import { accountAgentPluginApi, plainHostedInput } from "./agent-plugin-account-api"
import { createStore } from "solid-js/store"
import type { AgentPluginHarness } from "@/features/agent-plugins/api"

const catalog = {
  revision: 7,
  supportedHarnesses: [],
  projects: [{ id: "project-1", label: "Project One" }],
  selectedProjectId: "project-1",
  candidates: [],
  errors: [],
}

function account(answer: (operation: HostedOperationName, input?: Record<string, unknown>) => unknown) {
  const calls: Array<{ operation: HostedOperationName; input?: Record<string, unknown> }> = []
  const port: AccountPort = {
    state: () => ({ status: "signed", identity: { userId: "user-1" } }),
    signIn: async () => {},
    signOut: async () => {},
    run: async (operation, input) => {
      calls.push({ operation, input })
      return answer(operation, input) as never
    },
  }
  return { port, calls }
}

describe("signed desktop Agent Plugins account client", () => {
  test("chooses the fixed project-refresh operation instead of constructing a query", async () => {
    const subject = account(() => ({ status: 200, body: catalog }))

    await expect(accountAgentPluginApi(subject.port).catalog({ projectId: "project-1", refresh: true })).resolves.toEqual(catalog)
    expect(subject.calls).toEqual([{
      operation: "agentPlugins.catalog.project.refresh",
      input: { projectId: "project-1" },
    }])
  })

  test("reads a plugin's skill document through the plain operation", async () => {
    const document = { name: "search", description: "Search the docs", markdown: "# Search" }
    const subject = account(() => ({ status: 200, body: document }))

    await expect(
      accountAgentPluginApi(subject.port).skill({ pluginInstanceId: "claxedo/docs", skill: "search" }),
    ).resolves.toEqual(document)
    expect(subject.calls).toEqual([{
      operation: "agentPlugins.skill",
      input: { pluginInstanceId: "claxedo/docs", skill: "search" },
    }])
  })

  test("chooses the project-scoped skill operation when a project is selected", async () => {
    const document = { name: "search", description: "Search the docs", markdown: "# Search" }
    const subject = account(() => ({ status: 200, body: document }))

    await expect(
      accountAgentPluginApi(subject.port).skill({
        pluginInstanceId: "claxedo/docs",
        skill: "search",
        projectId: "project-1",
      }),
    ).resolves.toEqual(document)
    expect(subject.calls).toEqual([{
      operation: "agentPlugins.skill.project",
      input: { pluginInstanceId: "claxedo/docs", skill: "search", projectId: "project-1" },
    }])
  })

  test("forwards the complete activation contract and preserves the server's canonical error", async () => {
    const subject = account(() => ({
      status: 409,
      body: { error: { code: "agent_plugins_revision_conflict", message: "revision changed" } },
    }))
    const api = accountAgentPluginApi(subject.port)
    const input = {
      pluginInstanceId: "claxedo/composio",
      harnessIds: ["codex" as const],
      choice: true,
      expectedRevision: 6,
      target: { scope: "all-projects" as const },
    }

    await expect(api.activation(input)).rejects.toThrow("revision changed")
    expect(subject.calls).toEqual([{ operation: "agentPlugins.activation", input }])
  })
})

describe("hosted inputs are plain data", () => {
  test("a Solid store proxy in the body is sent as a cloneable copy", async () => {
    const [store] = createStore({ harnessIds: ["opencode", "claude"] as AgentPluginHarness[] })
    const subject = account(() => ({ status: 200, body: { revision: 2, reconciliation: { state: "applied" } } }))
    await accountAgentPluginApi(subject.port).activation({ pluginInstanceId: "p", harnessIds: store.harnessIds, choice: true, expectedRevision: 1 })
    const sent = subject.calls[0]?.input
    expect(() => structuredClone(sent)).not.toThrow()
    expect(sent).toEqual({ pluginInstanceId: "p", harnessIds: ["opencode", "claude"], choice: true, expectedRevision: 1 })
    expect(plainHostedInput(undefined)).toBeUndefined()
  })
})
