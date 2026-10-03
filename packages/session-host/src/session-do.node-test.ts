import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, afterEach, before, describe, it } from "node:test"
import { generateKeyPair } from "jose"
import type { PluginProjection, RuntimeConfigSnapshotPlugins } from "@claxedo/harness/contract"
import { startScriptedModelServer, type ScriptedModelServer } from "../../harness/e2e/harness/scripted-model-server"
import { releasePort, reservePort } from "../../harness/e2e/harness/ports"
import { controlPlaneStandIn } from "./test-support/control-plane"
import { bundleSessionHostWorker, sessionHostClient, startSessionHostWorker } from "./test-support/session-host-worker"
import { startWorkspaceMachine } from "./test-support/workspace-machine"

const SECRET = "pi-session-host-secret"
const MODEL = { providerID: "pi", modelID: "openai/gpt-4.1" }

const STDIO_MCP = `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "machine-mcp", version: "1" } });
  if (message.method === "tools/list") return reply({ tools: [{ name: "proof", description: "Prove the machine ran this", inputSchema: { type: "object", properties: { marker: { type: "string" } } } }] });
  if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "MACHINE_MCP:" + message.params.arguments.marker + ":" + process.cwd() }] });
});
`

type StoredMessage = { info: { role: string; time?: { completed?: number } }; parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; output?: string; error?: string } }> }

const assistantText = (messages: StoredMessage[]) =>
  messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text ?? "").join("")

async function eventually<T>(read: () => Promise<T | undefined>, what: string, withinMs = 30_000): Promise<T> {
  const at = Date.now() + withinMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > at) throw new Error(`${what} did not happen within ${withinMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

void describe("SessionDO under workerd with PiHarness", () => {
  let script: string
  let directory: string
  let persist: string
  let model: ScriptedModelServer
  let modelPort: number
  let relayHost: Awaited<ReturnType<typeof generateKeyPair>>
  let runtimeAccess: Awaited<ReturnType<typeof generateKeyPair>>
  let machine: Awaited<ReturnType<typeof startWorkspaceMachine>>
  let plugins: RuntimeConfigSnapshotPlugins = { harnessLaunch: {}, mcp: {} }
  let projection: PluginProjection = { generation: "none", mcpServers: [], pluginRoots: [], notApplied: [] }
  const running: Array<{ dispose(): Promise<void> }> = []

  before(async () => {
    script = await bundleSessionHostWorker()
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "session-host-machine-")))
    persist = await mkdtemp(path.join(tmpdir(), "session-host-do-"))
    modelPort = await reservePort()
    model = await startScriptedModelServer({ port: modelPort, red: false })
    relayHost = await generateKeyPair("EdDSA", { extractable: true })
    runtimeAccess = await generateKeyPair("EdDSA", { extractable: true })
    machine = await startWorkspaceMachine({ directory, projection: () => projection, runtimeAccessKey: runtimeAccess.publicKey, relayHostKeys: relayHost })
  })

  afterEach(async () => {
    for (const worker of running.splice(0)) await worker.dispose()
  })

  after(async () => {
    await machine.close()
    await model.close()
    releasePort(modelPort)
    await rm(directory, { recursive: true, force: true })
    await rm(persist, { recursive: true, force: true })
  })

  async function session(root: string, options: { leaseTtlMs?: number } = {}) {
    const controlPlane = controlPlaneStandIn({
      root, relayHostKey: relayHost.publicKey, runtimeAccessKey: runtimeAccess.privateKey,
      direct: () => ({ delivery: "direct", baseUrl: model.url, apiPath: "/v1", secret: SECRET, authKind: "api-key" }), plugins: () => plugins, machine: () => ({ relayUrl: machine.relayUrl, directory }),
    })
    if (options.leaseTtlMs) controlPlane.control.leaseTtlMs = options.leaseTtlMs
    const boot = async () => {
      const worker = await startSessionHostWorker({ script, persist, relayHostKey: relayHost.publicKey, controlPlane: controlPlane.fetch })
      running.push(worker)
      return { worker, client: sessionHostClient(worker, { root, relayHostSigningKey: relayHost.privateKey }) }
    }
    let current = await boot()
    await current.client.json(`/session/${root}`, { method: "POST", headers: { "x-claxedo-session-registration-operation": `op_${root}` },
      body: { harness: { id: "pi", access: "native" }, model: { providerID: MODEL.providerID, id: MODEL.modelID } } })
    const json = <T>(...args: Parameters<typeof current.client.json>) => current.client.json<T>(...args)
    const prompt = (messageID: string, text: string) =>
      json(`/session/${root}/prompt_async`, { method: "POST", body: { parts: [{ type: "text", text }], messageID, model: MODEL } })
    const messages = () => json<StoredMessage[]>(`/session/${root}/message`)
    const settled = (marker: string) => eventually(async () => {
      const read = await messages()
      return assistantText(read).includes(marker) ? read : undefined
    }, `the answer ${marker}`).catch(async (error: unknown) => {
      throw new Error(`${String(error)}\n${JSON.stringify(await messages())}\nmodel: ${JSON.stringify(model.requests.slice(-3).map((request) => [request.prompt.slice(-300), request.reply, request.tools.map((tool) => tool.name)]))}\ncontrol plane: ${JSON.stringify(controlPlane.calls)}\n${current.worker.stderr()}`)
    })
    /** The machine the object ran on dies; a new workerd opens the same storage and nothing asks it anything. */
    const crash = async () => {
      running.splice(running.indexOf(current.worker), 1)
      await current.worker.dispose()
      current = await boot()
    }
    /** The tables in the object's SQLite file, read beside workerd. */
    const tables = async () => {
      const id = (await current.worker.getDurableObjectNamespace("SESSION_HOST")).idFromName(root).toString()
      const database = new DatabaseSync(path.join(persist, "-SessionDO", `${id}.sqlite`), { readOnly: true })
      try {
        return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").all().map((row) => String(row.name))
      } finally { database.close() }
    }
    return { json, controlPlane, prompt, messages, settled, crash, tables }
  }

  async function pidFrom(file: string) {
    return eventually(async () => existsSync(file) ? Number(await readFile(file, "utf8")) || undefined : undefined, `${file} written`)
  }

  void it("runs a Pi turn in the object with its tool on the machine, reads the transcript from the object, and asks for one delivery", { timeout: 120_000 }, async () => {
    const root = "ses_turn"
    const host = await session(root)
    model.scriptTool({ name: "write", input: { path: "written.txt", content: "the session host wrote this\n" }, whenPromptIncludes: "PIWRITE" })
    await host.prompt("msg_write", "Write the file, then reply with exactly this one token: PIWRITE")
    const messages = await host.settled("PIWRITE")
    assert.equal(await readFile(path.join(directory, "written.txt"), "utf8"), "the session host wrote this\n")
    assert.ok(messages.some((message) => message.parts.some((part) => part.type === "tool" && part.tool === "write")))
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_write"])
    await host.prompt("msg_again", "Reply with exactly this one token: PIAGAIN")
    await host.settled("PIAGAIN")
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_write", "msg_again"])
    assert.ok(host.controlPlane.calls.executions.length >= 1)
    const spent = new Set(model.requests.filter((request) => request.prompt.includes("PIWRITE")).map((request) => request.authorization))
    assert.deepEqual(spent, new Set([`Bearer ${SECRET}`]))
  })

  void it("stops a turn and the command it was running on the machine", { timeout: 120_000 }, async () => {
    const root = "ses_stop"
    const host = await session(root)
    const pidFile = path.join(directory, "stop.pid")
    model.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 60` }, whenPromptIncludes: "PISTOP" })
    await host.prompt("msg_stop", "Run it, then reply with exactly this one token: PISTOP")
    const pid = await pidFrom(pidFile)
    assert.equal(pidAlive(pid), true)
    const inspected = await host.json<{ target: { ownerGeneration: string } }>(`/session/${root}/recovery`)
    await host.json(`/session/${root}/recovery`, { method: "POST", body: {
      requestId: "stop_1", action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1,
    } })
    await eventually(async () => pidAlive(pid) ? undefined : true, `bash ${pid} retired`, 15_000)
    assert.equal(assistantText(await host.messages()).includes("PISTOP"), false)
  })

  void it("resumes a run lost mid-tool when Pi's wake alarm restarts the object, under the lease it took over", { timeout: 120_000 }, async () => {
    const root = "ses_evict"
    const host = await session(root)
    const pidFile = path.join(directory, "evict.pid")
    model.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 60` }, whenPromptIncludes: "PIEVICT" })
    await host.prompt("msg_evict", "Run it, then reply with exactly this one token: PIEVICT")
    const pid = await pidFrom(pidFile)
    const answeredBefore = model.requests.length
    await host.crash()
    await eventually(async () => pidAlive(pid) ? undefined : true, `bash ${pid} retired with the lost object`, 15_000)
    await eventually(async () => host.controlPlane.calls.deliveries.length === 2 && model.requests.length > answeredBefore ? true : undefined,
      "the alarm restarting the object and Pi asking the model again", 60_000)
    const messages = await host.settled("PIEVICT")
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_evict", "msg_evict"])
    await eventually(async () => host.controlPlane.calls.releases.includes("msg_evict") ? true : undefined, "the taken-over lease released once Pi went idle")
    assert.ok(messages.some((message) => message.parts.some((part) => part.state?.status === "error" && /interrupted/.test(part.state.error ?? ""))),
      JSON.stringify(messages))
  })

  void it("aborts the run it took over when the authority refuses to renew that lease", { timeout: 120_000 }, async () => {
    const root = "ses_refused"
    const host = await session(root, { leaseTtlMs: 8_000 })
    const pidFile = path.join(directory, "refused.pid")
    model.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 60` }, whenPromptIncludes: "PIREFUSED" })
    await host.prompt("msg_refused", "Run it, then reply with exactly this one token: PIREFUSED")
    await pidFrom(pidFile)
    const release = model.holdTextReplies("PIREFUSED")
    try {
      host.controlPlane.control.refuseRenewals = true
      const renewals = host.controlPlane.calls.renewals
      await host.crash()
      await host.messages()
      await model.textGateReached("PIREFUSED")
      await eventually(async () => host.controlPlane.calls.renewals > renewals ? true : undefined, "the taken-over lease's renewal refused", 20_000)
      await eventually(async () => {
        const messages = await host.messages()
        const last = messages.at(-1)
        return last?.info.role === "assistant" && last.info.time?.completed ? messages : undefined
      }, "the continuation ending once its lease was refused", 20_000)
    } finally { release() }
    assert.equal(assistantText(await host.messages()).includes("PIREFUSED"), false)
    assert.deepEqual(host.controlPlane.calls.releases.includes("msg_refused"), false)
  })

  void it("calls a plugin's stdio MCP server on the machine through the relay", { timeout: 120_000 }, async () => {
    const root = "ses_mcp"
    const server = path.join(directory, "machine-mcp.cjs")
    await writeFile(server, STDIO_MCP)
    projection = { generation: "g1", pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "stdio", name: "machine", origin: "plugin", command: process.execPath, args: [server] }] }
    plugins = { harnessLaunch: { pi: { generation: "g1", execution: { mode: "default" }, pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "stdio", name: "machine", origin: "plugin", command: "machine" }] } }, mcp: {} }
    const host = await session(root)
    model.scriptTool({ name: "mcp__machine__proof", input: { marker: "M1" }, whenPromptIncludes: "PIMCP" })
    await host.prompt("msg_mcp", "Call it, then reply with exactly this one token: PIMCP")
    const messages = await host.settled("PIMCP")
    assert.ok(JSON.stringify(messages).includes(`MACHINE_MCP:M1:${directory}`), JSON.stringify(messages))
  })

  void it("wipes the object's storage once its session is deleted", { timeout: 120_000 }, async () => {
    const root = "ses_delete"
    const host = await session(root)
    await host.prompt("msg_delete", "Reply with exactly this one token: PIDELETE")
    await host.settled("PIDELETE")
    await host.crash()
    assert.ok((await host.tables()).includes("session_host_meta"))
    assert.deepEqual(await host.json(`/session/${root}`, { method: "DELETE" }), { ok: true })
    await host.crash()
    assert.deepEqual(await host.tables(), [])
    await assert.rejects(host.messages(), /answered 404/)
  })
})
