import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createAgentRuntime } from "../../runtime"
import { createMemoryRuntimeStore } from "../../stores/memory"
import type { AgentMessage } from "../../index"
import { claude } from "../index"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { resolveClaudeExecutable } from "./executable"

/**
 * The held-open turn input against the real Claude Code CLI.
 *
 * Claude has no correlated provider acknowledgement for a message sent into a
 * running turn, so the driver refuses steering rather than promoting a local
 * stdin write to acceptance. `driver.test.ts` substitutes `query`, so it proves
 * what the driver hands the SDK and nothing about the process on the other
 * side: that the refused prompt never reaches the model, and that the query
 * still terminates once the driver closes stdin on the turn's result. A
 * credentialled Claude is not needed for either question — the model is the one
 * part that can be stubbed — so this spawns the installed CLI against a local
 * Anthropic endpoint that streams the first answer slowly enough for a mid-turn
 * prompt to land in.
 *
 * `steer-conformance.live.test.ts` asks the same thing of a credentialled
 * harness and skips when there is none.
 */

const COUNT_MARKER = "COUNT-TO-TWENTY"
const STEER_MARKER = "STEERED-BY-STDIN"
const SLOW_REPLY_LINES = 20
const SLOW_REPLY_GAP_MS = 250
const TURN_BUDGET_MS = 120_000

type StubApi = Awaited<ReturnType<typeof stubAnthropicApi>>

/**
 * Enough of `/v1/messages` for the CLI to run a turn: an SSE text response per
 * request, slow only for the counting prompt so the steer has a turn to land
 * in. The CLI's own side calls (post-turn summaries) share the endpoint and
 * answer instantly.
 */
async function stubAnthropicApi() {
  const requests: string[] = []
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ input_tokens: 8 }))
      return
    }
    if (!request.url?.includes("/v1/messages")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
      return
    }
    requests.push(body)
    const event = (payload: { type: string }) =>
      response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    event({
      type: "message_start",
      message: {
        id: `msg_stub_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 },
      },
    } as never)
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never)
    const delta = (text: string) =>
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as never)
    if (body.includes(STEER_MARKER)) delta(STEER_MARKER)
    else if (body.includes(COUNT_MARKER)) {
      for (let line = 1; line <= SLOW_REPLY_LINES; line++) {
        delta(`${line}\n`)
        await new Promise((resolve) => setTimeout(resolve, SLOW_REPLY_GAP_MS))
      }
    } else delta("ok")
    event({ type: "content_block_stop", index: 0 } as never)
    event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } } as never)
    event({ type: "message_stop" } as never)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The CLI reads these from its spawn environment, which the driver copies from this process. */
function withAnthropicEnv(stub: StubApi) {
  const previous = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY }
  process.env.ANTHROPIC_BASE_URL = stub.url
  process.env.ANTHROPIC_API_KEY = "sk-ant-stub-key"
  return () => {
    if (previous.base === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previous.base
    if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous.key
  }
}

function textOf(message: AgentMessage | undefined) {
  return (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

const claudeBinary = resolveClaudeExecutable()

describe("the Claude turn input the driver holds open", () => {
  test.skipIf(claudeBinary === undefined)(
    "refuses a prompt sent mid-turn with its reason, and the CLI turn still ends on its own",
    async () => {
      const stub = await stubAnthropicApi()
      const restoreEnv = withAnthropicEnv(stub)
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-turn-input-")))
      const runtime = createAgentRuntime({
        store: createMemoryRuntimeStore(),
        harnesses: [claude()],
      })
      try {
        const session = await runtime.sessions.create({
          workspaceId: "workspace-claude-turn-input",
          directory,
          harness: { id: "claude", access: "native" },
          title: "claude turn input",
        })
        const startedAt = Date.now()
        const terminal = (async () => {
          for await (const event of runtime.events.subscribe({ sessionId: session.id })) {
            const { type } = event.payload as { type: string }
            if (type === "session.idle" || type === "session.error") return type
          }
          return "stream closed before the turn ended"
        })()

        const first = await runtime.turns.start({
          sessionId: session.id,
          text: `Count from 1 to ${SLOW_REPLY_LINES}, one number per line. ${COUNT_MARKER}`,
        })
        expect(first.delivery).toBe("start")

        const assistantText = async () =>
          textOf((await runtime.events.list(session.id)).find((message) => message.info.id === first.assistantMessageId))
        const producing = Date.now() + TURN_BUDGET_MS
        while (Date.now() < producing && !(await assistantText()).trim()) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const beforeSteer = await assistantText()
        expect(beforeSteer, "the CLI streamed nothing to steer into").not.toBe("")

        const steered = await runtime.turns.start({
          sessionId: session.id,
          delivery: "steer",
          text: `Stop counting and reply with exactly ${STEER_MARKER}`,
        })
        expect(steered.delivery).toBe("queue")
        expect(steered.steering).toMatchObject({ ok: false, status: "unsupported" })
        expect(steered.assistantMessageId).not.toBe(first.assistantMessageId)

        let timer: ReturnType<typeof setTimeout> | undefined
        const ended = await Promise.race([
          terminal,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve(`the query hung: no result within ${TURN_BUDGET_MS}ms`), TURN_BUDGET_MS)
          }),
        ]).finally(() => clearTimeout(timer))
        expect(ended).toBe("session.idle")
        expect((await runtime.sessions.get(session.id))?.lastTurn)
          .toMatchObject({ status: "completed", assistantMessageId: first.assistantMessageId })

        // The refusal is the whole point: nothing was written to the stdin the
        // driver still held open, so no request the CLI made carries the marker.
        expect(stub.requests.filter((body) => body.includes(STEER_MARKER))).toHaveLength(0)

        const messages = await runtime.events.list(session.id)
        expect(messages.filter((message) => message.info.role === "assistant").map((message) => message.info.id))
          .toEqual([first.assistantMessageId])
        const reply = await assistantText()
        expect(reply).toContain(`${SLOW_REPLY_LINES}\n`)
        expect(reply).not.toContain(STEER_MARKER)
        // A refused prompt has no place in the transcript: acceptance is what
        // would earn one, and there was none.
        expect(messages.find((message) => message.info.id === steered.userMessageId)).toBeUndefined()

        console.log(
          `[claude cli] refused a steer after ${beforeSteer.split("\n").length - 1} streamed lines, `
            + `turn ended in ${Date.now() - startedAt}ms over ${stub.requests.length} model requests`,
        )
      } finally {
        await runtime.dispose()
        restoreEnv()
        await stub.close()
        removeTestTempDir(directory)
      }
    },
    TURN_BUDGET_MS + 60_000,
  )
})
