import { expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { AcpHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { createAcpConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"

test("public workspace creation answers an actual ACP startup RPC before provider binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-startup-wire-"))
  const target = { workspaceId: "startup-workspace", directory }
  let send!: (message: AnyMessage) => void
  let creationId: string | number | null | undefined
  let response: AnyMessage | undefined
  const original = createAcpConnectionProvider()
  const provider: typeof original = {
    ...original,
    createAdapter({ descriptor, context }) {
      return new AcpHarnessAdapter({ harness: descriptor.connectionId, store: context.store, eventHub: context.eventHub,
        connection: { kind: "process", command: "wire-peer" }, createTransport() {
          let alive = true
          return { kind: "stdio", metadata: {}, get alive() { return alive }, dispose() { alive = false }, stream: {
            readable: new ReadableStream<AnyMessage>({ start(controller) { send = message => controller.enqueue(message) } }),
            writable: new WritableStream<AnyMessage>({ write(message) {
              if (!("method" in message)) {
                if (message.id === "startup-question") {
                  response = message
                  send({ jsonrpc: "2.0", id: creationId!, result: { sessionId: "real-provider-session" } })
                }
                return
              }
              if (!("id" in message)) return
              if (message.method === "session/new") {
                creationId = message.id
                send({ jsonrpc: "2.0", id: "startup-question", method: "elicitation/create", params: { requestId: message.id, mode: "form", message: "Choose before creation", requestedSchema: { type: "object", properties: { name: { type: "string", pattern: "^[A-Z][a-z]+$" }, bounded: { type: "string", pattern: "^(a+)+$" } }, required: ["name"] } } })
                return
              }
              send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : {} })
            } }),
          } }
        } })
    },
  }
  const host = createWorkspaceHost({ target, storeRoot: join(directory, "store"), connectionProviders: [provider] })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  try {
    await host.apply({ version: 4, auth: {}, mcp: {}, connections: [{ connectionId: "startup-agent", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Startup agent", connection: { kind: "process", command: "wire-peer" } } }], defaultHarness: { kind: "connection", connectionId: "startup-agent" } })
    const creating = request("/session?connectionId=startup-agent", "POST", { id: "local-start" })
    let questions: Array<{ id: string; sessionID: string }> = []
    for (let n = 0; n < 100 && !questions.length; n++) {
      questions = await (await request("/question?sessionId=local-start")).json()
      if (!questions.length) await Bun.sleep(5)
    }
    expect(questions).toHaveLength(1)
    expect(questions[0].sessionID).toBe("local-start")
    expect(await (await request("/session")).json()).toEqual([])
    expect(await (await request("/session-start/local-start")).json()).toMatchObject({ status: "starting", binding: { sessionId: "local-start", connectionId: "connection:startup-agent" } })
    const rejected = await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ name: "invalid-123" })]] })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: { code: "elicitation_invalid_answer" } })
    expect(response).toBeUndefined()
    expect(await (await request("/question?sessionId=local-start")).json()).toMatchObject([{ id: questions[0].id }])
    // A worker timeout must not consume the agent RPC or durable question.
    const timedOut = await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ name: "Chosen", bounded: "a".repeat(100) + "!" })]] })
    expect(timedOut.status).toBe(422)
    expect(await timedOut.json()).toMatchObject({ error: { code: "elicitation_validation_timeout" } })
    expect(response).toBeUndefined()
    expect(await (await request("/question?sessionId=local-start")).json()).toMatchObject([{ id: questions[0].id }])
    const answered = await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ name: "Chosen" })]] })
    expect(answered.status).toBe(200)
    expect(response).toMatchObject({ result: { action: "accept", content: { name: "Chosen" } } })
    expect((await creating).status).toBe(201)
    expect(await (await request("/session-start/local-start")).json()).toMatchObject({ status: "created", upstreamSessionId: "real-provider-session" })
    expect(await (await request("/question?sessionId=local-start")).json()).toEqual([])
    expect(await (await request("/session/local-start")).json()).toMatchObject({ id: "local-start" })
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
})


test("external stdio startup isolates refusal, retires crashed questions, and permits explicit recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-startup-stdio-"))
  const target = { workspaceId: "stdio-workspace", directory }
  const logPath = join(directory, "peer.jsonl")
  const peerPath = fileURLToPath(new URL("./fixtures/acp-startup-peer.mjs", import.meta.url))
  const host = createWorkspaceHost({ target, storeRoot: join(directory, "store") })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  let pid: number | undefined
  try {
    await host.apply({ version: 4, auth: {}, mcp: {}, connections: [{ connectionId: "stdio-startup", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Stdio startup", connection: { kind: "process", command: "node", args: [peerPath, logPath] } } }], defaultHarness: { kind: "connection", connectionId: "stdio-startup" } })
    expect(host.detail().connectionState).toMatchObject({ connectionId: "stdio-startup", state: "configured", processes: [] })
    for (const [id, label] of [["first", "accepted"], ["refused", "fail"], ["last", "still-alive"]]) {
      const creating = request("/session", "POST", { id })
      let questions: Array<{ id: string }> = []
      for (let n = 0; n < 200 && !questions.length; n++) {
        questions = await (await request(`/question?sessionId=${id}`)).json()
        if (!questions.length) await Bun.sleep(5)
      }
      expect(questions).toHaveLength(1)
      expect((await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ label })]] })).status).toBe(200)
      expect((await creating).status).toBe(label === "fail" ? 500 : 201)
      const state = await (await request(`/session-start/${id}`)).json()
      expect(state.status).toBe(label === "fail" ? "failed" : "created")
      expect(host.detail().connectionState).toMatchObject({ connectionId: "stdio-startup", state: "ready" })
    }
    const log = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    pid = log[0].pid
    expect(new Set(log.map(row => row.pid)).size).toBe(1)
    expect(log.filter(row => row.method === "session/new")).toHaveLength(3)
    expect(log.some(row => row.method === "session/prompt")).toBe(false)

    const interrupted = request("/session", "POST", { id: "interrupted" })
    let pending: Array<{ id: string }> = []
    for (let n = 0; n < 200 && !pending.length; n++) {
      pending = await (await request("/question?sessionId=interrupted")).json()
      if (!pending.length) await Bun.sleep(5)
    }
    expect(pending).toHaveLength(1)
    process.kill(pid!, "SIGKILL")
    expect((await interrupted).status).toBe(500)
    expect(await (await request("/session-start/interrupted")).json()).toMatchObject({ status: "failed" })
    expect(await (await request("/question?sessionId=interrupted")).json()).toEqual([])
    expect((await request(`/question/${pending[0].id}/reply`, "POST", { answers: [[JSON.stringify({ label: "too-late" })]] })).status).toBe(404)
    expect((await request("/session/interrupted")).status).toBe(404)

    const restarted = request("/session", "POST", { id: "after-crash" })
    pending = []
    for (let n = 0; n < 200 && !pending.length; n++) {
      pending = await (await request("/question?sessionId=after-crash")).json()
      if (!pending.length) await Bun.sleep(5)
    }
    expect(pending).toHaveLength(1)
    expect((await request(`/question/${pending[0].id}/reply`, "POST", { answers: [[JSON.stringify({ label: "recovered" })]] })).status).toBe(200)
    expect((await restarted).status).toBe(201)
    const recoveredLog = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(new Set(recoveredLog.map(row => row.pid)).size).toBe(2)
    expect(recoveredLog.some(row => row.method === "session/prompt")).toBe(false)
    pid = recoveredLog.at(-1).pid
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
  // After the finally, not inside it: a claim about the peer's exit made while
  // the body is unwinding replaces the failure the body was reporting.
  if (pid) {
    let exit: NodeJS.ErrnoException["code"]
    for (let n = 0; n < 200 && exit === undefined; n++) {
      try { process.kill(pid, 0); await Bun.sleep(5) } catch (error) {
        exit = (error as NodeJS.ErrnoException).code
      }
    }
    expect(exit).toBe("ESRCH")
  }
})
