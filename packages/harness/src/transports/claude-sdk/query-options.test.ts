import { expect, test } from "bun:test"
import { query, type Query } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, HarnessSession, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { claudeTranslator } from "./events"
import { ClaudeMirroredUsage } from "./mirrored-usage"
import type { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"

test("every Claude launch streams its input with partial messages and replayed prompts, and offers no wakeups", async () => {
  const calls: Parameters<typeof query>[0][] = []
  const runQuery = ((call: Parameters<typeof query>[0]) => { calls.push(call); return {} as Query }) as typeof query
  const services = { firstPartyMcp: () => ({ name: "claxedo", kind: "http", url: "http://127.0.0.1:48810",
    headers: { authorization: "Bearer local" } }) } as unknown as HarnessServices
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
    owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" }, permissionMode: "plan" },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [{ pluginInstanceId: "one", root: "/plugin", skillNames: [], dataRoot: "/data" }], notApplied: [] },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }
  const session: HarnessSession = { directory: input.directory, locality: input.locality,
    binding: { sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "claude-sdk", upstreamSessionId: "up1" } }
  const broker = { sessionId: "s1", config: () => input.config, goal: { read: () => null, publish: async () => {} } } as unknown as SessionBroker
  const mirroredUsage = new ClaudeMirroredUsage(claudeTranslator("a1").runtime, { broker, assistantMessageId: "a1", directory: "/work" })
  const launcher = new ClaudeQueryLauncher(services, { executable: "claude", configRoot: "/tmp/claxedo", userConfigRoot: "/tmp/user", env: {} }, runQuery)
  const prompt = (async function* () {})()
  await launcher.launch({ session, input, broker, abort: new AbortController(), processes: new Set<ClaudeProcess>(), usage: mirroredUsage, prompt,
    turn: () => ({ broker: { signal: new AbortController().signal } as TurnBroker, turnId: "t1" }), model: "default", agent: "reviewer", system: "system" })
  const options = calls[0]!.options!
  expect(options).toMatchObject({ agent: "reviewer", includePartialMessages: true, systemPrompt: { append: "system" }, resume: "up1", forwardSubagentText: true,
    disallowedTools: ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"] })
  expect(calls[0]!.prompt).toBe(prompt)
  expect(options.tools).toBeUndefined()
  expect(JSON.stringify(options.env)).not.toContain("Bearer local")
  expect(options.extraArgs).toEqual({ "thinking-display": "summarized", "replay-user-messages": null })
  const key = { projectKey: "project", sessionId: "up1" }
  expect(await options.sessionStore?.load(key)).toBeNull()
  expect(await options.sessionStore?.listSessions?.("project")).toEqual([])
  expect(await options.sessionStore?.listSubkeys?.(key)).toEqual([])
})
