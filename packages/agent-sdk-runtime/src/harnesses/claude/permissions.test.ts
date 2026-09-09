import { expect, test } from "bun:test"
import type { Query, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { PendingPermission, SdkRuntimeDriverHost, SdkRuntimeTurnInput } from "../shared/sdk-runtime-driver"
import { CLAUDE_DENY_FLOOR } from "../shared/permission-modes"
import { applyClaudePermissionUpdates, createClaudeSdkDriver, type ClaudeSdkDriverOptions } from "./driver"

const suggestions: PermissionUpdate[] = [
  { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "printf approved-write *" }], destination: "localSettings" },
  { type: "addDirectories", directories: ["/tmp/approved"], destination: "session" },
]

function turn(sessionId: string): SdkRuntimeTurnInput {
  return {
    sessionId,
    getAgentSessionId: () => `claude-sdk:${sessionId}`,
    input: { parts: [{ type: "text", text: "write" }], assistantMessageId: "assistant-1", agent: "build", model: { providerID: "claude", modelID: "sonnet" } },
    directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
    observeSubagent: async () => ({ event: {} }), rebindAgentSession() {}, model: "sonnet",
  } as unknown as SdkRuntimeTurnInput
}

for (const decision of ["allow_always", "allow_once", "deny", "storage-failure"] as const) {
  test(`${decision} carries only accepted grants into a recreated driver and isolates other sessions`, async () => {
    const states = new Map<string, Record<string, unknown>>()
    const pendingPermissions = new Map<string, PendingPermission>()
    const calls: Parameters<NonNullable<ClaudeSdkDriverOptions["query"]>>[0][] = []
    let ask = true
    const host: SdkRuntimeDriverHost = {
      lifecycle: () => createSessionTurnLifecycle(), pendingPermissions, pendingQuestions: new Map(),
      bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
      getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
      getSessionConfig: (id) => ({ harness: { id: "claude", access: "native" }, permissionState: states.get(id) }),
      updatePermissionState: (id, state) => {
        if (decision === "storage-failure") throw new Error("Permission store unavailable")
        states.set(id, structuredClone(state))
      },
    }
    const query: NonNullable<ClaudeSdkDriverOptions["query"]> = (input) => {
      calls.push(input)
      return Object.assign((async function* () {
        if (!ask) return
        ask = false
        const reply = input.options!.canUseTool!("Bash", { command: "printf approved-write" }, {
          signal: new AbortController().signal, suggestions, blockedPath: "/tmp/approved/result", toolUseID: "tool-1", requestId: "request-1",
        })
        pendingPermissions.values().next().value!.resolve(decision === "storage-failure" ? "allow_always" : decision)
        const result = await reply
        if (!result) throw new Error("Expected a permission decision")
        expect(result.behavior).toBe(decision === "deny" ? "deny" : "allow")
        if (result.behavior === "allow") {
          expect(result.updatedPermissions).toEqual(decision === "allow_always" ? suggestions.map((item) => ({ ...item, destination: "session" })) : undefined)
        }
      })(), { close() {} }) as unknown as Query
    }
    const driver = () => createClaudeSdkDriver(host, { query, executable: () => "/fake/claude" })
    if (decision === "storage-failure") await expect(driver().runTurn(turn("approved"))).rejects.toThrow("Permission store unavailable")
    else await driver().runTurn(turn("approved"))
    await driver().runTurn(turn("approved"))
    await driver().runTurn(turn("other"))
    const permissions = (index: number) => (calls[index]!.options!.settings as { permissions: Record<string, unknown> }).permissions
    expect(permissions(1).allow).toEqual(decision === "allow_always" ? ["Bash(printf approved-write *)"] : [])
    expect(calls[1]!.options!.additionalDirectories).toEqual(decision === "allow_always" ? ["/tmp/approved"] : [])
    expect(permissions(2).allow).toEqual([])
    expect(calls[2]!.options!.additionalDirectories).toEqual([])
    for (let i = 0; i < 3; i++) expect(permissions(i).deny).toEqual([...CLAUDE_DENY_FLOOR])
  })
}

test("native rule replacements and removals remain scoped to their behavior and preserve exact rule contents", () => {
  const result = applyClaudePermissionUpdates({ allow: ["Read", "Bash(old)"], deny: ["Write"], additionalDirectories: ["/old"] }, [
    { type: "replaceRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "echo (hello)" }, { toolName: "Read" }], destination: "session" },
    { type: "removeRules", behavior: "allow", rules: [{ toolName: "Read" }], destination: "session" },
    { type: "removeDirectories", directories: ["/old"], destination: "session" },
    { type: "setMode", mode: "plan", destination: "session" },
  ])
  expect(result).toEqual({ permissions: { allow: ["Bash(echo (hello))"], deny: ["Write"], ask: [], additionalDirectories: [] }, mode: "plan" })
})

for (const decision of ["allow_always", "allow_once", "deny", "reject_always"] as const) {
  test(`${decision} only reuses the exact accepted Bash request after driver reconstruction`, async () => {
    const states = new Map<string, Record<string, unknown>>()
    const pendingPermissions = new Map<string, PendingPermission>()
    const host = {
      lifecycle: () => createSessionTurnLifecycle(), pendingPermissions, pendingQuestions: new Map(),
      bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
      getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
      getSessionConfig: (id: string) => ({ harness: { id: "claude", access: "native" }, permissionState: states.get(id) }),
      updatePermissionState: (id: string, state: Record<string, unknown>) => states.set(id, JSON.parse(JSON.stringify(state))),
    } as SdkRuntimeDriverHost
    let requests = 0
    let callbacks = 0
    const run = async (sessionId: string, answer: typeof decision, overrides: {
      directory?: string; mode?: string; tool?: string; input?: Record<string, unknown>; context?: Record<string, unknown>
    } = {}) => {
      const query: NonNullable<ClaudeSdkDriverOptions["query"]> = ({ options }) => Object.assign((async function* () {
        callbacks++
        const result = options!.canUseTool!(overrides.tool ?? "Bash", overrides.input ?? { command: "printf approved > /tmp/approved/result" }, {
          signal: new AbortController().signal, suggestions, blockedPath: "/tmp/approved/result",
          toolUseID: `tool-${callbacks}`, requestId: `request-${callbacks}`, ...overrides.context,
        })
        for (const [id, pending] of pendingPermissions) {
          requests++
          pendingPermissions.delete(id)
          pending.resolve(answer)
        }
        const reply = await result
        if (!reply) throw new Error("Expected a permission decision")
        expect(reply.behavior).toBe(answer === "allow_always" || answer === "allow_once" ? "allow" : "deny")
      })(), { close() {} }) as unknown as Query
      const driver = createClaudeSdkDriver(host, { query, executable: () => "/fake/claude" })
      if (overrides.mode) await driver.setPermissionMode!(sessionId, overrides.mode, overrides.directory ?? "/repo")
      await driver.runTurn({ ...turn(sessionId), directory: overrides.directory ?? "/repo" })
    }
    await run("approved", decision)
    expect(requests).toBe(1)
    await run("approved", decision)
    expect(requests).toBe(decision === "allow_always" ? 1 : 2)
    await run("approved", decision, { input: { command: "printf approved > /tmp/approved/result", description: "A new display label" } })
    expect(requests).toBe(decision === "allow_always" ? 1 : 3)
    for (const [sessionId, overrides] of [
      ["other", {}],
      ["approved", { directory: "/other" }],
      ["approved", { mode: "plan" }],
      ["approved", { tool: "Write", input: { file_path: "/tmp/approved/result", content: "changed" } }],
      ["approved", { input: { command: "rm /tmp/approved/result" } }],
      ["approved", { context: { blockedPath: "/tmp/other" } }],
      ["approved", { context: { agentID: "child" } }],
      ["approved", { context: { futurePolicy: "new" } }],
      ["approved", { context: { matchedAskRule: { toolName: "Bash" } } }],
      ["approved", { context: { decisionReason: "new safety check" } }],
    ] as const) {
      const before = requests
      await run(sessionId, "deny", overrides)
      expect(requests).toBe(before + 1)
    }
    const restored: Record<string, unknown> = applyClaudePermissionUpdates(states.get("approved"), []).permissions
    expect(restored.claudeCommandGrants)
      .toEqual(states.get("approved")?.claudeCommandGrants)
  })
}
