import { expect, test } from "bun:test"
import { query, type Query } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, HarnessSession, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { claudeTranslator } from "./events"
import { ClaudeMirroredUsage } from "./mirrored-usage"
import type { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"

test("turns and native goals share session options while clear forbids tools", async () => {
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
  const base = { session, input, broker, abort: new AbortController(), processes: new Set<ClaudeProcess>(), usage: mirroredUsage }
  await launcher.launch({ ...base, prompt: "turn", turn: () => ({ broker: { signal: new AbortController().signal } as TurnBroker, turnId: "t1" }),
    model: "default", agent: "reviewer", system: "system", partialMessages: true })
  await launcher.launch({ ...base, prompt: "/goal Ship" })
  await launcher.launch({ ...base, prompt: "/goal clear", clear: true })
  const options = calls.map((call) => call.options)
  const shared = (value: NonNullable<typeof options[number]>) => ({ cwd: value.cwd, env: value.env, resume: value.resume,
    permissionMode: value.permissionMode, settings: value.settings, additionalDirectories: value.additionalDirectories,
    plugins: value.plugins, mcpServers: value.mcpServers, settingSources: value.settingSources,
    forwardSubagentText: value.forwardSubagentText, pathToClaudeCodeExecutable: value.pathToClaudeCodeExecutable })
  expect(shared(options[0]!)).toEqual(shared(options[1]!))
  expect(shared(options[1]!)).toEqual(shared(options[2]!))
  expect(options[0]).toMatchObject({ agent: "reviewer", includePartialMessages: true,
    systemPrompt: { append: "system" } })
  expect(options[1]?.tools).toBeUndefined()
  expect(options[2]).toMatchObject({ tools: [], maxTurns: 1 })
  expect(options[2]?.sessionStore).toBeUndefined()
  expect(JSON.stringify(options[0]?.env)).not.toContain("Bearer local")
  expect(options[0]?.extraArgs).toEqual({ "thinking-display": "summarized", "replay-user-messages": null })
  expect(options[1]?.extraArgs).toEqual({ "thinking-display": "summarized" })
  const key = { projectKey: "project", sessionId: "up1" }
  expect(await options[1]?.sessionStore?.load(key)).toBeNull()
  expect(await options[1]?.sessionStore?.listSessions?.("project")).toEqual([])
  expect(await options[1]?.sessionStore?.listSubkeys?.(key)).toEqual([])
})
