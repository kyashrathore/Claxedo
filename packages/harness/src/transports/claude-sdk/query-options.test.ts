import { expect, test } from "bun:test"
import { query, type Query } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, HarnessSession, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { claudeTranslator } from "./events"
import type { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"

test("turns and native goals share session options while clear forbids tools", async () => {
  const calls: Parameters<typeof query>[0][] = []
  const runQuery = ((call: Parameters<typeof query>[0]) => { calls.push(call); return {} as Query }) as typeof query
  const services = { firstPartyMcp: () => ({ name: "claxedo", kind: "http", url: "http://127.0.0.1:48810",
    headers: { authorization: "Bearer local" } }) } as unknown as HarnessServices
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
    owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" }, permissionMode: "plan" },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [{ pluginInstanceId: "one", root: "/plugin", dataRoot: "/data" }], notApplied: [] },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" } }
  const session: HarnessSession = { directory: input.directory, locality: input.locality,
    binding: { sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "claude-sdk", upstreamSessionId: "up1" } }
  const broker = { sessionId: "s1", config: () => input.config, goal: { read: () => null, publish: async () => {} } } as unknown as SessionBroker
  const { runtime } = claudeTranslator("a1")
  const launcher = new ClaudeQueryLauncher(services, { executable: "claude", configRoot: "/tmp/claxedo", userConfigRoot: "/tmp/user", env: {} }, runQuery)
  const base = { session, input, broker, abort: new AbortController(), processes: new Set<ClaudeProcess>(), runtime, assistantMessageId: "a1" }
  await launcher.launch({ ...base, prompt: "turn", turnBroker: { signal: new AbortController().signal } as TurnBroker,
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
})
