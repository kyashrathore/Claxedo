import { expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"

test("public workspace creation answers an actual ACP startup RPC before provider binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-startup-wire-"))
  const target = { workspaceId: "startup-workspace", directory }
  const logPath = join(directory, "peer.jsonl")
  const peerPath = fileURLToPath(new URL("./fixtures/acp-startup-peer.mjs", import.meta.url))
  const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(directory, "store") })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  const answersSent = async () => (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .filter((row: { method?: string; result?: unknown }) => !row.method && row.result !== undefined)
  try {
    await host.apply({ version: 4, commands: [], auth: { machineOwnerUserId: "local", accounts: { local: {} } }, mcp: {}, connections: [{ connectionId: "startup-agent", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Startup agent", connection: { kind: "process", command: "node", args: [peerPath, logPath, "patterns"] } } }], defaultHarness: { kind: "connection", connectionId: "startup-agent" } })
    const creating = request("/session?connectionId=startup-agent", "POST", { id: "local-start" })
    let questions: Array<{ id: string; sessionID: string }> = []
    for (let n = 0; n < 200 && !questions.length; n++) {
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
    expect(await answersSent()).toEqual([])
    expect(await (await request("/question?sessionId=local-start")).json()).toMatchObject([{ id: questions[0].id }])
    // A worker timeout must not consume the agent RPC or durable question.
    const timedOut = await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ name: "Chosen", bounded: "a".repeat(100) + "!" })]] })
    expect(timedOut.status).toBe(422)
    expect(await timedOut.json()).toMatchObject({ error: { code: "elicitation_validation_timeout" } })
    expect(await answersSent()).toEqual([])
    expect(await (await request("/question?sessionId=local-start")).json()).toMatchObject([{ id: questions[0].id }])
    const answered = await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ name: "Chosen" })]] })
    expect(answered.status).toBe(200)
    expect((await creating).status).toBe(201)
    expect(await answersSent()).toMatchObject([{ result: { action: "accept", content: { name: "Chosen" } } }])
    expect(await (await request("/session-start/local-start")).json()).toMatchObject({ status: "created", upstreamSessionId: expect.stringMatching(/^startup-/) })
    expect(await (await request("/question?sessionId=local-start")).json()).toEqual([])
    expect(await (await request("/session/local-start")).json()).toMatchObject({ id: "local-start" })
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
})


test("external stdio startup isolates refusal, retires crashed questions, and permits explicit recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-startup-stdio-"))
  const target = { workspaceId: "stdio-workspace", directory }
  const logPath = join(directory, "peer.jsonl")
  const peerPath = fileURLToPath(new URL("./fixtures/acp-startup-peer.mjs", import.meta.url))
  const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(directory, "store") })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  const peerLog = async () => (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; method?: string })
  const pendingQuestion = async (id: string) => {
    let questions: Array<{ id: string }> = []
    for (let n = 0; n < 200 && !questions.length; n++) {
      questions = await (await request(`/question?sessionId=${id}`)).json()
      if (!questions.length) await Bun.sleep(5)
    }
    return questions
  }
  const pids = new Set<number>()
  try {
    await host.apply({ version: 4, commands: [], auth: { machineOwnerUserId: "local", accounts: { local: {} } }, mcp: {}, connections: [{ connectionId: "stdio-startup", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Stdio startup", connection: { kind: "process", command: "node", args: [peerPath, logPath] } } }], defaultHarness: { kind: "connection", connectionId: "stdio-startup" } })
    expect(host.detail().connectionState).toMatchObject({ connectionId: "stdio-startup", state: "configured", processes: [] })
    for (const [id, label] of [["first", "accepted"], ["refused", "fail"], ["last", "still-alive"]]) {
      const creating = request("/session", "POST", { id })
      const questions = await pendingQuestion(id)
      expect(questions).toHaveLength(1)
      expect((await request(`/question/${questions[0].id}/reply`, "POST", { answers: [[JSON.stringify({ label })]] })).status).toBe(200)
      expect((await creating).status).toBe(label === "fail" ? 500 : 201)
      const state = await (await request(`/session-start/${id}`)).json()
      expect(state.status).toBe(label === "fail" ? "failed" : "created")
      expect(host.detail().connectionState).toMatchObject({ connectionId: "stdio-startup", state: "ready" })
    }
    const log = await peerLog()
    for (const row of log) pids.add(row.pid)
    const starts = log.filter(row => row.method === "session/new")
    expect(starts).toHaveLength(3)
    // Each session runs its own agent process, so a refused startup takes no other session's agent with it.
    expect(new Set(starts.map(row => row.pid)).size).toBe(3)
    expect(log.some(row => row.method === "session/prompt")).toBe(false)

    const interrupted = request("/session", "POST", { id: "interrupted" })
    const pending = await pendingQuestion("interrupted")
    expect(pending).toHaveLength(1)
    const interruptedPid = (await peerLog()).filter(row => row.method === "session/new").at(-1)!.pid
    pids.add(interruptedPid)
    process.kill(interruptedPid, "SIGKILL")
    expect((await interrupted).status).toBe(500)
    expect(await (await request("/session-start/interrupted")).json()).toMatchObject({ status: "failed" })
    expect(await (await request("/question?sessionId=interrupted")).json()).toEqual([])
    expect((await request(`/question/${pending[0].id}/reply`, "POST", { answers: [[JSON.stringify({ label: "too-late" })]] })).status).toBe(404)
    expect((await request("/session/interrupted")).status).toBe(404)

    const restarted = request("/session", "POST", { id: "after-crash" })
    const recovering = await pendingQuestion("after-crash")
    expect(recovering).toHaveLength(1)
    expect((await request(`/question/${recovering[0].id}/reply`, "POST", { answers: [[JSON.stringify({ label: "recovered" })]] })).status).toBe(200)
    expect((await restarted).status).toBe(201)
    const recoveredLog = await peerLog()
    for (const row of recoveredLog) pids.add(row.pid)
    expect(recoveredLog.filter(row => row.method === "session/new").at(-1)!.pid).not.toBe(interruptedPid)
    expect(recoveredLog.some(row => row.method === "session/prompt")).toBe(false)
  } finally {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  }
  // After the finally, not inside it: a claim about the peers' exit made while
  // the body is unwinding replaces the failure the body was reporting.
  for (const pid of pids) {
    let exit: NodeJS.ErrnoException["code"]
    for (let n = 0; n < 200 && exit === undefined; n++) {
      try { process.kill(pid, 0); await Bun.sleep(5) } catch (error) {
        exit = (error as NodeJS.ErrnoException).code
      }
    }
    expect(exit).toBe("ESRCH")
  }
})
