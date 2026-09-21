import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAgentRuntime } from "../../runtime"
import { harnessFactory } from "../../harness-factories/factory"
import { PiRpcProcess } from "./rpc-process"
import { volatileLaunchOwnership } from "../../launch"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { GOAL_PROMPT_TEXT } from "../shared/goal-protocol"
import { cancelAdapterTurn } from "../../test-utils/cancel-turn"
import { pinnedPiExecutable } from "../../test-utils/pinned-pi"
import { PiHarnessAdapter } from "./index"
import { piProviderOverrides, retainPiAuth } from "./auth"

const binary = pinnedPiExecutable()
/** A groq model Pi 0.85.1 defines with image input over chat completions. */
const PROOF_MODEL = "qwen/qwen3.6-27b"

/**
 * A real pinned Pi process and native tools on a bound account; only the
 * provider HTTP response is deterministic. The account reaches Pi the way the
 * adapter delivers one — a `models.json` overlay onto Pi's own `groq` — so
 * every request here carries the placeholder on the binding's own path.
 */
test(
  "real Pi public runtime executes a native file tool, records usage, and resumes its own session",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-proof-"))
    const agentDir = path.join(directory, "agent")
    const requests: Array<{ messages: Array<Record<string, unknown>> }> = []
    const providerRequests: Array<{ pathname: string; authorization: string | null }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        providerRequests.push({ pathname: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
        const body = (await request.json()) as (typeof requests)[number]
        requests.push(body)
        const evaluator = JSON.stringify(body.messages).includes(GOAL_PROMPT_TEXT.evaluatorObjectiveLabel)
        const tool = requests.length === 1
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "proof_write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ path: "proof.txt", content: "written by native Pi" }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: evaluator
                ? JSON.stringify({ met: true, reason: "Native file verified" })
                : "Native work complete",
            }
        const chunks =
          [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            {
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            },
          ]
            .map(
              (chunk) =>
                `data: ${JSON.stringify({ id: `proof-${requests.length}`, object: "chat.completion.chunk", created: 1, model: PROOF_MODEL, ...chunk })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n"
        return new Response(chunks, { headers: { "content-type": "text/event-stream" } })
      },
    })
    const projection = {
      baseUrl: `http://127.0.0.1:${server.port}/bindings/7c2d`,
      placeholder: "signed-placeholder",
      authMode: "bearer" as const,
      expiresAt: Date.now() + 60 * 60 * 1000,
      apiPath: "/openai/v1",
    }
    const model = { providerID: "pi", modelID: `groq/${PROOF_MODEL}` }
    const store = createMemoryRuntimeStore()
    const rows = store
    const create = async () => {
      let adapter: PiHarnessAdapter | undefined
      const runtime = createAgentRuntime({
        store,
        harnesses: [harnessFactory("pi", "native", (context) => {
          adapter = new PiHarnessAdapter({ store: context.store, agentDir, eventHub: context.eventHub, binary })
          return adapter
        })],
      })
      await adapter!.applyConfig({ auth: { groq: projection } })
      return runtime
    }
    let runtime = await create()
    const usage: Array<{ messageID: string; observation: { tokens: { input: number; output: number } } }> = []
    const turn = async (sessionId: string, messageId: string) => {
      const events = runtime.events.subscribe({ sessionId })
      const collected = (async () => {
        for await (const event of events) {
          if (event.payload.type === "session.usage") usage.push(event.payload.properties as (typeof usage)[number])
          if (event.payload.type === "session.error") throw new Error(JSON.stringify(event.payload))
          if (event.payload.type === "session.idle") break
        }
      })()
      await runtime.turns.start({
        sessionId,
        messageId,
        parts: [
          { type: "text", text: "Perform the requested file operation" },
          ...(messageId === "first"
            ? [
                {
                  type: "file" as const,
                  mime: "image/png",
                  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lp8AAAAASUVORK5CYII=",
                },
              ]
            : []),
        ],
      })
      await collected
    }
    try {
      const session = await runtime.sessions.create({
        workspaceId: "proof-workspace",
        directory,
        harness: { id: "pi", access: "native" },
        model,
      })
      expect(rows.getSessionConfig(session.id)?.model).toEqual(model)
      const nativeId = rows.getAgentSessionId(session.id)
      expect(nativeId).not.toBe(session.id)
      await turn(session.id, "first")
      expect(providerRequests).toHaveLength(2)
      expect(providerRequests.every((request) => request.pathname === "/bindings/7c2d/openai/v1/chat/completions"
        && request.authorization === "Bearer signed-placeholder")).toBe(true)
      expect(await fs.readFile(path.join(directory, "proof.txt"), "utf8")).toBe("written by native Pi")
      expect(JSON.stringify(requests[0].messages)).toContain("data:image/png;base64,")
      expect(requests[1].messages.some((message) => message.role === "tool")).toBe(true)
      expect(JSON.stringify(rows.getMessages(session.id))).toContain("Native work complete")
      expect(usage).toHaveLength(2)
      expect(usage.every((event) => event.messageID === "first_r")).toBe(true)
      expect(usage.reduce((sum, event) => sum + event.observation.tokens.input, 0)).toBe(24)
      expect(usage.reduce((sum, event) => sum + event.observation.tokens.output, 0)).toBe(16)
      expect(
        rows.getMessages(session.id).find((message) => message.info.role === "assistant")?.info
          .time,
      ).toHaveProperty("completed")
      const files = await fs.readdir(path.join(agentDir, "sessions"))
      expect(files.some((file) => file.endsWith(`_${nativeId}.jsonl`))).toBe(true)
      await runtime.dispose()
      runtime = await create()
      await turn(session.id, "second")
      expect(rows.getAgentSessionId(session.id)).toBe(nativeId)
      expect(requests.at(-1)!.messages.filter((message) => message.role === "user")).toHaveLength(2)
      await runtime.dispose()
      await fs.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 4096 } }),
      )
      const nativeFile = path.join(
        agentDir,
        "sessions",
        files.find((file) => file.endsWith(`_${nativeId}.jsonl`))!,
      )
      // The last adapter's disposal scrubbed the overlay; a bare Pi on the
      // session file needs the bound account back for the summary turn.
      const profile = retainPiAuth(agentDir)
      await profile.write(piProviderOverrides({ groq: projection }))
      const rpc = await PiRpcProcess.start({
        binary,
        directory,
        args: ["--mode", "rpc", "--session", nativeFile, "--provider", "groq", "--model", PROOF_MODEL],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        ownership: volatileLaunchOwnership(),
      })
      try {
        const compacted = await rpc.request("compact", { customInstructions: "Keep the file edit and completion." })
        expect(compacted).toHaveProperty("summary")
        expect(await fs.readFile(nativeFile, "utf8")).toContain('"type":"compaction"')
      } finally {
        await rpc.dispose()
        await profile.release()
      }
      runtime = await create()
      expect(
        (await runtime.goals.start({ sessionId: session.id, objective: "Verify proof.txt contains the native edit" }))
          .ok,
      ).toBe(true)
      const deadline = Date.now() + 15_000
      let goal = await runtime.goals.read(session.id)
      while (goal?.status === "active" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        goal = await runtime.goals.read(session.id)
      }
      expect(goal).toMatchObject({ status: "complete", iteration: 1 })
      expect(JSON.stringify(rows.getMessages(session.id))).not.toContain('"met"')
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain(GOAL_PROMPT_TEXT.evaluatorObjectiveLabel)
    } finally {
      await runtime.dispose()
      await server.stop(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

test(
  "real Pi loads a workspace extension and exposes its input request before the provider runs",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-extension-proof-"))
    const agentDir = path.join(directory, "agent")
    await fs.mkdir(path.join(directory, ".pi", "extensions"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".pi", "extensions", "question.ts"),
      `import { writeFileSync } from "node:fs"; export default function (pi) { pi.on("before_agent_start", async (_event, ctx) => { const answer = await ctx.ui.input("Native extension question"); if (answer) writeFileSync("extension-answer.txt", answer); }); }`,
    )
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          proof: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "local-test",
            models: [{ id: "proof", reasoning: false, contextWindow: 32000, maxTokens: 4096 }],
          },
        },
      }),
    )
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }))
    const store = createMemoryRuntimeStore()
    const adapter = new PiHarnessAdapter({ store, binary, agentDir })
    try {
      const session = await adapter.createSession(directory)
      const binding = {
        workspaceId: "proof-workspace",
        directory,
        sessionId: session.id,
        upstreamSessionId: store.getAgentSessionId(session.id)!,
        connectionId: "native:pi",
      }
      // Pi validates credentials before the extension hook; this local provider is never called.
      const execute = () =>
        (async () => {
          for await (const _event of adapter.executeTurn(binding, {
            parts: [{ type: "text", text: "Ask the extension" }],
            model: { providerID: "pi", modelID: "proof/proof" },
            agent: "build",
            assistantMessageId: "extension-proof",
          })) {
          }
        })()
      const execution = execute()
      let pending = await adapter.listQuestions(directory)
      for (let attempt = 0; attempt < 200 && !pending.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        pending = await adapter.listQuestions(directory)
      }
      expect(pending[0]?.questions[0]?.question).toBe("Native extension question")
      expect(await cancelAdapterTurn(adapter, binding)).toMatchObject({ execution: "terminal" })
      await execution
      expect(await adapter.listQuestions(directory)).toEqual([])
      const answeredTurn = execute()
      for (let attempt = 0; attempt < 200; attempt++) {
        pending = await adapter.listQuestions(directory)
        if (pending.length) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(pending).toHaveLength(1)
      await adapter.replyQuestion(binding, pending[0].id, [["native answer"]])
      const answerFile = path.join(directory, "extension-answer.txt")
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          await fs.stat(answerFile).then(
            () => true,
            () => false,
          )
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(await fs.readFile(answerFile, "utf8")).toBe("native answer")
      await cancelAdapterTurn(adapter, binding)
      await answeredTurn
    } finally {
      await adapter.dispose()
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)

/**
 * The broker contract a bound turn honours, on the real pinned Pi: the
 * `models.json` overlay the adapter writes is what Pi 0.85.1 reads, so the
 * placeholder goes out as the bearer token on the binding's own path and no
 * other credential goes out at all.
 */
test(
  "a bound account reaches the provider as the placeholder on the binding's own path",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-binding-proof-"))
    const agentDir = path.join(directory, "agent")
    const requests: Array<{ pathname: string; authorization: string | null }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push({ pathname: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
        const chunks = [
          { choices: [{ index: 0, delta: { role: "assistant", content: "Bound turn complete" }, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify({ id: "bound-1", object: "chat.completion.chunk", created: 1, model: "llama-3.1-8b-instant", ...chunk })}\n\n`)
          .join("") + "data: [DONE]\n\n"
        return new Response(chunks, { headers: { "content-type": "text/event-stream" } })
      },
    })
    const previousKey = process.env.GROQ_API_KEY
    process.env.GROQ_API_KEY = "operator-own-groq-key"
    const store = createMemoryRuntimeStore()
    const adapter = new PiHarnessAdapter({ store, binary, agentDir })
    try {
      await adapter.applyConfig({ auth: { groq: {
        baseUrl: `http://127.0.0.1:${server.port}/bindings/7c2d`,
        placeholder: "signed-placeholder",
        authMode: "bearer",
        expiresAt: Date.now() + 60 * 60 * 1000,
        apiPath: "/openai/v1",
      } } })
      adapter.setModel("groq/llama-3.1-8b-instant")
      const session = await adapter.createSession(directory)
      const binding = {
        workspaceId: "proof-workspace",
        directory,
        sessionId: session.id,
        upstreamSessionId: store.getAgentSessionId(session.id)!,
        connectionId: "native:pi",
      }
      const events: unknown[] = []
      for await (const event of adapter.executeTurn(binding, {
        parts: [{ type: "text", text: "Reply with exactly OK." }],
        model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" },
        agent: "build",
        assistantMessageId: "bound-turn",
      })) {
        events.push(event)
      }
      expect(requests).toEqual([{ pathname: "/bindings/7c2d/openai/v1/chat/completions", authorization: "Bearer signed-placeholder" }])
      expect(JSON.stringify(events)).toContain("Bound turn complete")
      expect(JSON.stringify(events)).not.toContain("operator-own-groq-key")
    } finally {
      if (previousKey === undefined) delete process.env.GROQ_API_KEY
      else process.env.GROQ_API_KEY = previousKey
      await adapter.dispose()
      await server.stop(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
