/**
 * A real engine turn metered through the adapter: a two-step turn against an
 * OpenAI-compatible endpoint that reports usage on the wire, read back as the
 * runtime usage events the turn meter consumes.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { AgentRuntimeStreamEvent } from "@claxedo/agent-sdk-runtime"
import { OpenCodeSdkHarnessAdapter } from "./harness-adapter"
import { createOpenCodeRuntime } from "./runtime"

type ChatRequest = { messages?: Array<{ role?: string }> }
type UsageEvent = Extract<AgentRuntimeStreamEvent, { type: "usage" }>
type Tokens = NonNullable<UsageEvent["observation"]>["tokens"]

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

test("a two-step turn meters each step in disjoint categories and closes on their sum", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-turn-usage-")))
  const directory = path.join(root, "work")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "README.md"), "# usage\n")
  const endpoint = scriptedEndpoint(path.join(directory, "README.md"))
  const baseURL = await endpoint.listen()
  const runtime = createOpenCodeRuntime({
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
          options: { baseURL, apiKey: "proof-key" },
        },
      },
    }),
  })
  const adapter = new OpenCodeSdkHarnessAdapter({ runtime, workspaceID: "ws_1", directory, reportOwnerFailure: () => {} })
  try {
    // Titled, so the engine spends nothing generating one.
    const { id } = await adapter.createSession(directory, "usage")
    const events: AgentRuntimeStreamEvent[] = []
    for await (const event of adapter.executeTurn(
      { workspaceId: "ws_1", directory, sessionId: id, connectionId: "native:opencode", upstreamSessionId: id },
      {
        parts: [{ type: "text", text: "read the readme" }],
        assistantMessageId: "caller-assistant-1",
        agent: "build",
        model: { providerID: "proof", modelID: "proof" },
      },
    )) events.push(event)

    const usage = events.filter((event): event is UsageEvent => event.type === "usage")
    const ids = usage.map((event) => event.observation?.providerObservationId)
    expect(new Set(ids).size).toBe(3)
    for (const observationId of ids) expect(observationId).toMatch(new RegExp(`^${id}:\\d+$`))
    const observation = (kind: "delta" | "cumulative", tokens: Tokens) => ({ kind, providerObservationId: expect.any(String), nativeSessionId: id, tokens })
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
  } finally {
    await runtime.close()
    await endpoint.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
