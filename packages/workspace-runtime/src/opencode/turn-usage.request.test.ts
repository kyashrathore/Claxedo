/**
 * A real engine turn metered through the OpenCode transport: a two-step turn
 * against an OpenAI-compatible endpoint that reports usage on the wire, read
 * back as the runtime usage events the turn meter consumes.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "@claxedo/harness/broker"
import type { HarnessServices, StartInput, TurnInput } from "@claxedo/harness/contract"
import { OpenCodeSdkTransport } from "@claxedo/harness/opencode-sdk"
import { MemoryPorts, authority, origin, removeTempRoot } from "@claxedo/harness/testing"

type ChatRequest = { messages?: Array<{ role?: string }> }
type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>
type Tokens = NonNullable<UsageEvent["observation"]>["tokens"]

const WORKSPACE = "ws_1"
const MODEL = { providerID: "proof", modelID: "proof" }

/**
 * Answers the first step with a tool call and the step after the tool result
 * with text. OpenAI's usage is inclusive: `prompt_tokens` counts cached input
 * and `completion_tokens` counts reasoning.
 */
function scriptedEndpoint(readme: string) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as ChatRequest
    const afterTool = (body.messages ?? []).some((message) => message.role === "tool")
    const send = (chunk: object) =>
      response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`)
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (afterTool) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })
      send({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170, prompt_tokens_details: { cached_tokens: 100 } },
      })
    } else {
      const call = { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: readme }) } }
      send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] })
      send({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      })
    }
    response.end("data: [DONE]\n\n")
  })
  return {
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
      const address = server.address()
      return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** The embedded engine runs in this process, so nothing here spawns or asks a pattern evaluator. */
function services(): HarnessServices {
  return {
    spawn: async (_command, options) => { throw new Error(`The embedded engine spawns nothing (${options.label})`) },
    recordHomeUse: async () => {},
    firstPartyMcp: () => undefined,
    healthChanged: () => {},
    patternEvaluator: async () => {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  }
}

test("a two-step turn meters each step in disjoint categories and closes on their sum", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-turn-usage-")))
  const directory = path.join(root, "work")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "README.md"), "# usage\n")
  const endpoint = scriptedEndpoint(path.join(directory, "README.md"))
  const baseURL = await endpoint.listen()
  const transport = new OpenCodeSdkTransport(services(), {
    databasePath: path.join(root, "opencode.db"),
    configContent: JSON.stringify({
      model: "proof/proof",
      small_model: "proof/proof",
      enabled_providers: ["proof"],
      provider: {
        proof: {
          npm: "@ai-sdk/openai-compatible",
          name: "Proof",
          models: { proof: { name: "Proof", limit: { context: 32_000, output: 1_024 } } },
        },
      },
    }),
  })
  const ports = new MemoryPorts()
  ports.directories.set("s1", directory)
  ports.current.set("s1", { ...authority, workspaceId: WORKSPACE, directory })
  const owner = createRequestBroker(ports)
  const sessionBroker = createSessionBroker(owner, { sessionId: "s1", directory, workspaceId: WORKSPACE, origin })
  const start: StartInput = {
    sessionId: "s1",
    workspaceId: WORKSPACE,
    directory,
    locality: "local",
    // Titled, so the engine spends nothing generating one.
    title: "usage",
    owner: { kind: "machine-owner" },
    model: MODEL,
    config: { harness: { id: "opencode", access: "native" }, model: MODEL },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: { proof: { baseUrl: baseURL, placeholder: "proof-key", authMode: "api-key" } }, secrets: {}, leaseGeneration: "one" },
  }
  try {
    const session = await transport.start(start, sessionBroker)
    const id = session.binding.upstreamSessionId
    const turn: TurnInput = {
      turnId: "caller-assistant-1",
      userMessageId: "caller-user-1",
      assistantMessageId: "caller-assistant-1",
      origin,
      model: MODEL,
      prompt: { agent: "build", assistantMessageId: "caller-assistant-1", parts: [{ type: "text", text: "read the readme" }] },
      todos: [],
    }
    const broker = createTurnBroker(owner, {
      authority: { ...authority, workspaceId: WORKSPACE, directory, upstreamSessionId: id },
      origin,
      signal: new AbortController().signal,
    })
    const events: AgentRuntimeEvent[] = []
    for await (const routed of transport.send(session, turn, broker)) events.push(routed.event)

    const usage = events.filter((event): event is UsageEvent => event.type === "usage")
    const ids = usage.map((event) => event.observation?.providerObservationId)
    expect(new Set(ids).size).toBe(3)
    for (const observationId of ids) expect(observationId).toMatch(new RegExp(`^${id}:\\d+$`))
    // The engine records the model each step ran on; every step here ran on `proof/proof`.
    const observation = (kind: "delta" | "cumulative", tokens: Tokens) => ({ kind, providerObservationId: expect.any(String), nativeSessionId: id, model: "proof", tokens })
    expect(usage).toEqual([
      {
        type: "usage",
        contextSize: 0,
        contextUsed: 100,
        observation: observation("delta", { input: 60, output: 20, reasoning: 10, cache: { read: 40, write: 0 } }),
        harness: "opencode",
      },
      {
        type: "usage",
        contextSize: 0,
        contextUsed: 150,
        observation: observation("delta", { input: 50, output: 20, reasoning: 0, cache: { read: 100, write: 0 } }),
        harness: "opencode",
      },
      {
        type: "usage",
        contextSize: 0,
        contextUsed: 150,
        observation: observation("cumulative", { input: 110, output: 40, reasoning: 10, cache: { read: 140, write: 0 } }),
        harness: "opencode",
      },
    ])
    expect(events.at(-1)).toEqual({ type: "finish", sessionId: id, harness: "opencode" })
    await transport.close(session)
  } finally {
    await transport.dispose()
    await endpoint.close()
    await removeTempRoot(root)
  }
}, 60_000)
