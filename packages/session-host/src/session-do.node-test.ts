import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, afterEach, before, describe, it } from "node:test"
import { generateKeyPair } from "jose"
import type { PluginProjection, RuntimeConfigSnapshotPlugins } from "@claxedo/harness/contract"
import { asRecord, asString } from "@claxedo/helpers/guards"
import { startScriptedModelServer, type ScriptedModelServer } from "../../harness/e2e/harness/scripted-model-server"
import { eventually } from "../../harness/e2e/harness/eventually"
import { releasePort, reservePort } from "../../harness/e2e/harness/ports"
import { controlPlaneStandIn, OWNER } from "./test-support/control-plane"
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

/** A streamable-HTTP MCP server that keeps sessions in memory and loses them all on `restart()`. */
async function restartableHttpMcp() {
  const sessions = new Set<string>()
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") return void response.writeHead(204).end()
    if (request.method !== "POST") return void response.writeHead(405).end()
    let body = ""
    for await (const chunk of request) body += String(chunk)
    const message = asRecord(JSON.parse(body))
    const params = asRecord(message?.params)
    const session = request.headers["mcp-session-id"]
    if (message?.method !== "initialize" && (typeof session !== "string" || !sessions.has(session))) return void response.writeHead(404).end()
    if (message?.id === undefined) return void response.writeHead(202).end()
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      response.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    if (message.method === "initialize") {
      const id = crypto.randomUUID()
      sessions.add(id)
      return reply({ protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "remote-mcp", version: "1" } }, { "mcp-session-id": id })
    }
    if (message.method === "tools/list") return reply({ tools: [{ name: "proof", inputSchema: { type: "object", properties: { marker: { type: "string" } } } }] })
    return reply({ content: [{ type: "text", text: `REMOTE_MCP:${asString(asRecord(params?.arguments)?.marker)}` }] })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The MCP server is not listening on a port")
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    restart: () => sessions.clear(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

type StoredMessage = { info: { role: string; time?: { completed?: number } }; parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; output?: string; error?: string } }> }

const assistantText = (messages: StoredMessage[]) =>
  messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text ?? "").join("")

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

  const openai = (secret: string) => ({ openai: { delivery: "direct" as const, baseUrl: model.url, apiPath: "/v1", secret, authKind: "api-key" as const } })

  async function session(root: string, options: { leaseTtlMs?: number; creator?: string; reservation?: string; accounts?: Record<string, ReturnType<typeof openai>> } = {}) {
    const creator = options.creator ?? OWNER
    const controlPlane = controlPlaneStandIn({
      root, relayHostKey: relayHost.publicKey, runtimeAccessKey: runtimeAccess.privateKey,
      accounts: () => options.accounts ?? { [OWNER]: openai(SECRET) }, plugins: () => plugins, machine: () => ({ relayUrl: machine.relayUrl, directory }),
      workspaceSessions: () => [{ id: "ses_listed_on_machine", title: "WORKSPACE_SESSION_ROW" }],
      sessionHost: () => (path, init) => sessionHostClient(worker, { root, relayHostSigningKey: relayHost.privateKey, user: creator }).request(path, init),
    })
    if (options.leaseTtlMs) controlPlane.control.leaseTtlMs = options.leaseTtlMs
    const boot = async () => {
      const worker = await startSessionHostWorker({ script, persist, relayHostKey: relayHost.publicKey, controlPlane: controlPlane.fetch })
      running.push(worker)
      return worker
    }
    let worker = await boot()
    const as = (user: string) => sessionHostClient(worker, { root, relayHostSigningKey: relayHost.privateKey, user })
    await as(creator).json(`/session/${root}`, { method: "POST", headers: { "x-claxedo-session-registration-operation": options.reservation ?? `op_${root}` },
      body: { harness: { id: "pi", access: "native" }, model: { providerID: MODEL.providerID, id: MODEL.modelID } } })
    const json = <T>(...args: Parameters<ReturnType<typeof as>["json"]>) => as(creator).json<T>(...args)
    const prompt = (messageID: string, text: string) =>
      json(`/session/${root}/prompt_async`, { method: "POST", body: { parts: [{ type: "text", text }], messageID, model: MODEL } })
    const messages = () => json<StoredMessage[]>(`/session/${root}/message`)
    const settled = (marker: string) => eventually(`the answer ${marker}`, async () => {
      const read = await messages()
      return assistantText(read).includes(marker) ? read : undefined
    }, 30_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}\n${JSON.stringify(await messages())}\nmodel: ${JSON.stringify(model.requests.slice(-3).map((request) => [request.prompt.slice(-300), request.reply, request.tools.map((tool) => tool.name)]))}\ncontrol plane: ${JSON.stringify(controlPlane.calls)}\n${worker.stderr()}`)
    })
    const sqlite = async () => path.join(persist, "-SessionDO", `${(await worker.getDurableObjectNamespace("SESSION_HOST")).idFromName(root).toString()}.sqlite`)
    /** The machine the object ran on dies; a new workerd opens the same storage and nothing asks it anything. */
    const crash = async (offline?: (database: DatabaseSync) => void) => {
      const file = await sqlite()
      running.splice(running.indexOf(worker), 1)
      await worker.dispose()
      if (offline) {
        const database = new DatabaseSync(file)
        try { offline(database) } finally { database.close() }
      }
      worker = await boot()
    }
    /** The tables in the object's SQLite file, read beside workerd. */
    const tables = async () => {
      const database = new DatabaseSync(await sqlite(), { readOnly: true })
      try {
        return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").all().map((row) => String(row.name))
      } finally { database.close() }
    }
    return { json, as, controlPlane, prompt, messages, settled, crash, tables, sqlite }
  }

  async function pidFrom(file: string) {
    return eventually(`${file} written`, async () => existsSync(file) ? Number(await readFile(file, "utf8")) || undefined : undefined, 30_000)
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

  void it("keeps delivered model options after an idle object restart without requesting another secret delivery", { timeout: 120_000 }, async () => {
    const root = "ses_catalog"
    const host = await session(root)
    await host.prompt("msg_catalog", "Reply with exactly this one token: PICATALOG")
    await host.settled("PICATALOG")
    await eventually("the catalog turn lease released", async () => host.controlPlane.calls.releases.includes("msg_catalog") ? true : undefined)
    const before = await host.json<{ options: Array<{ id: string; currentValue?: string }> }>(`/session/${root}/config-options`)
    assert.equal(before.options.find((option) => option.id === "model")?.currentValue, MODEL.modelID)
    await host.crash()
    assert.deepEqual(await host.json(`/session/${root}/config-options`), before)
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_catalog"])
    await host.prompt("msg_restored_catalog", "Reply with exactly this one token: PIRESTOREDCATALOG")
    await host.settled("PIRESTOREDCATALOG")
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_catalog", "msg_restored_catalog"])
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
    await eventually(`bash ${pid} retired`, async () => pidAlive(pid) ? undefined : true, 15_000)
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
    await eventually(`bash ${pid} retired with the lost object`, async () => pidAlive(pid) ? undefined : true, 15_000)
    await eventually("the alarm restarting the object and Pi asking the model again", async () => host.controlPlane.calls.deliveries.length === 2 && model.requests.length > answeredBefore ? true : undefined, 60_000)
    const messages = await host.settled("PIEVICT")
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_evict", "msg_evict"])
    await eventually("the taken-over lease released once Pi went idle", async () => host.controlPlane.calls.releases.includes("msg_evict") ? true : undefined)
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
      await eventually("the taken-over lease's renewal refused", async () => host.controlPlane.calls.renewals > renewals ? true : undefined, 20_000)
      await eventually("the continuation ending once its lease was refused", async () => {
        const messages = await host.messages()
        const last = messages.at(-1)
        return last?.info.role === "assistant" && last.info.time?.completed ? messages : undefined
      }, 20_000)
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

  void it("initializes an HTTP MCP server's session again after the server lost it, and the call goes through", { timeout: 120_000 }, async () => {
    const remote = await restartableHttpMcp()
    const before = plugins
    plugins = { harnessLaunch: { pi: { generation: "remote", execution: { mode: "default" }, pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "http", name: "remote", origin: "plugin", url: remote.url }] } }, mcp: {} }
    try {
      const host = await session("ses_http_mcp_restart")
      const proved = async (marker: string) => {
        model.scriptTool({ name: "mcp__remote__proof", input: { marker }, whenPromptIncludes: marker })
        await host.prompt(`msg_${marker}`, `Call it, then reply with exactly this one token: ${marker}`)
        const messages = JSON.stringify(await host.settled(marker))
        assert.ok(messages.includes(`REMOTE_MCP:${marker}`), messages)
      }
      await proved("PIREMOTEFIRST")
      remote.restart()
      await proved("PIREMOTEAFTER")
    } finally {
      plugins = before
      await remote.close()
    }
  })

  void it("lists and calls Claxedo's first-party MCP session tools with the bearer its turn was delivered", { timeout: 120_000 }, async () => {
    const root = "ses_first_party_mcp"
    const host = await session(root)
    host.controlPlane.control.firstPartyMcp = true
    model.scriptTool({ name: "mcp__claxedo__sessions_list", input: {}, whenPromptIncludes: "PICLAXEDOMCP" })
    await host.prompt("msg_claxedo_mcp", "List the sessions, then reply with exactly this one token: PICLAXEDOMCP")
    const messages = await host.settled("PICLAXEDOMCP")
    assert.ok(JSON.stringify(messages).includes("WORKSPACE_SESSION_ROW"), JSON.stringify(messages))
    const offered = model.requests.find((request) => request.prompt.includes("PICLAXEDOMCP"))?.tools.map((tool) => tool.name) ?? []
    assert.ok(offered.includes("mcp__claxedo__sessions_list"), JSON.stringify(offered))
    assert.ok(host.controlPlane.calls.mcpBearers.length > 0)
    assert.ok(host.controlPlane.calls.mcpBearers.every((bearer) => bearer.startsWith("session-mcp-")), JSON.stringify(host.controlPlane.calls.mcpBearers))
  })

  void it("reads its own transcript through Claxedo's first-party MCP at its own object, which the machine does not hold", { timeout: 120_000 }, async () => {
    const root = "ses_first_party_mcp_self"
    const host = await session(root)
    host.controlPlane.control.firstPartyMcp = true
    model.scriptTool({ name: "mcp__claxedo__session_transcript", input: { session: root, limit: 10 }, whenPromptIncludes: "PISELFMCP" })
    await host.prompt("msg_self_mcp", "Read your own transcript, then reply with exactly this one token: PISELFMCP")
    const messages = await host.settled("PISELFMCP")
    const read = messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "mcp__claxedo__session_transcript")
    assert.equal(read?.state?.status, "completed", JSON.stringify(read))
    assert.ok(read?.state?.output?.includes("Read your own transcript"), JSON.stringify(read))
  })

  void it("calls Claxedo's first-party MCP tools on a later turn's rotated bearer and on another isolate of the endpoint", { timeout: 120_000 }, async () => {
    const root = "ses_first_party_mcp_rotation"
    const host = await session(root)
    host.controlPlane.control.firstPartyMcp = true
    const listed = async (marker: string) => {
      model.scriptTool({ name: "mcp__claxedo__sessions_list", input: {}, whenPromptIncludes: marker })
      await host.prompt(`msg_${marker}`, `List the sessions, then reply with exactly this one token: ${marker}`)
      return (await host.settled(marker)).flatMap((message) => message.parts)
        .filter((part) => part.tool === "mcp__claxedo__sessions_list").map((part) => [part.state?.status, part.state?.output?.includes("WORKSPACE_SESSION_ROW")])
    }
    await listed("PIROTATEFIRST")
    await listed("PIROTATESECOND")
    host.controlPlane.newMcpIsolate()
    const calls = await listed("PIROTATEISOLATE")
    assert.deepEqual(calls, [["completed", true], ["completed", true], ["completed", true]])
    assert.equal(new Set(host.controlPlane.calls.mcpBearers).size, 3)
  })

  void it("offers the first-party MCP tool groups the project has on from the next turn, and none once it turns them all off", { timeout: 120_000 }, async () => {
    const root = "ses_first_party_mcp_toggle"
    const host = await session(root)
    const control = host.controlPlane.control
    const offered = async (marker: string) => {
      await host.prompt(`msg_${marker}`, `Reply with exactly this one token: ${marker}`)
      await host.settled(marker)
      const tools = model.requests.find((request) => request.prompt.includes(marker))?.tools.map((tool) => tool.name) ?? []
      return ["mcp__claxedo__sessions_list", "mcp__claxedo__subagent_capabilities"].filter((name) => tools.includes(name))
    }
    assert.deepEqual(await offered("PITOGGLEOFF"), [])
    control.firstPartyMcp = true
    assert.deepEqual(await offered("PITOGGLEON"), ["mcp__claxedo__sessions_list"])
    control.toolGroups = ["sessions", "subagents"]
    assert.deepEqual(await offered("PITOGGLEMORE"), ["mcp__claxedo__sessions_list", "mcp__claxedo__subagent_capabilities"])
    control.toolGroups = ["subagents"]
    assert.deepEqual(await offered("PITOGGLEFEWER"), ["mcp__claxedo__subagent_capabilities"])
    control.firstPartyMcp = false
    assert.deepEqual(await offered("PITOGGLEOFFAGAIN"), [])
  })

  void it("spends the accounts of the person who created the session, and a creator without any spends nobody's", { timeout: 120_000 }, async () => {
    const member = "user_member"
    const accounts = { [OWNER]: openai(SECRET), [member]: openai("member-secret") }
    const host = await session("ses_member", { creator: member, accounts })
    await host.prompt("msg_member", "Reply with exactly this one token: PIMEMBER")
    await host.settled("PIMEMBER")
    const spent = new Set(model.requests.filter((request) => request.prompt.includes("PIMEMBER")).map((request) => request.authorization))
    assert.deepEqual(spent, new Set(["Bearer member-secret"]))

    const bare = await session("ses_bare", { creator: "user_bare", accounts })
    const answered = model.requests.length
    await bare.prompt("msg_bare", "Reply with exactly this one token: PIBARE")
    const refused = await eventually("the turn refused for want of an account", async () => {
      const reply = (await bare.messages()).find((message) => message.info.role === "assistant" && message.info.time?.completed)
      return reply ? JSON.stringify(reply.info) : undefined
    }, 30_000)
    assert.match(refused, /No selected account for session owner user_bare/)
    assert.equal(model.requests.slice(answered).some((request) => request.prompt.includes("PIBARE")), false)
  })

  void it("is refused what the control plane refuses: a create its reservation does not name, a viewer's turn and delete", { timeout: 120_000 }, async () => {
    await assert.rejects(session("ses_unreserved", { reservation: "op_someone_else" }), /answered 403/)

    const root = "ses_viewer"
    const host = await session(root)
    host.controlPlane.control.viewers.add("user_viewer")
    const viewer = host.as("user_viewer")
    await assert.rejects(viewer.json(`/session/${root}/prompt_async`, { method: "POST", body: { parts: [{ type: "text", text: "PIVIEWER" }], messageID: "msg_viewer", model: MODEL } }), /answered 403/)
    await assert.rejects(viewer.json(`/session/${root}`, { method: "DELETE" }), /answered 403/)
    assert.deepEqual(host.controlPlane.calls.deliveries, [])
    assert.deepEqual(host.controlPlane.calls.deletes, [])
    assert.ok((await host.tables()).includes("session_host_meta"))
    assert.ok(await host.json(`/session/${root}`))
  })

  void it("deletes the session at the control plane first, and erases the object only once that succeeded", { timeout: 120_000 }, async () => {
    const root = "ses_delete"
    const host = await session(root)
    await host.prompt("msg_delete", "Reply with exactly this one token: PIDELETE")
    await host.settled("PIDELETE")
    host.controlPlane.control.deleteUnavailable = true
    await assert.rejects(host.json(`/session/${root}`, { method: "DELETE" }), /answered 502: .*did not delete the session: 503/)
    assert.equal(assistantText(await host.messages()).includes("PIDELETE"), true)
    host.controlPlane.control.deleteUnavailable = false
    await host.crash()
    assert.ok((await host.tables()).includes("session_host_meta"))
    assert.deepEqual(await host.json(`/session/${root}`, { method: "DELETE" }), { ok: true, deletedSessionIds: [root] })
    assert.deepEqual(host.controlPlane.calls.deletes, [OWNER])
    await host.crash()
    assert.deepEqual(await host.tables(), [])
    await assert.rejects(host.messages(), /answered 403/)
  })

  void it("refuses a store this build does not read with a typed answer, retries its start on the next request, and can still be deleted", { timeout: 120_000 }, async () => {
    const root = "ses_unsupported"
    const host = await session(root)
    await host.prompt("msg_unsupported", "Reply with exactly this one token: PIUNSUPPORTED")
    await host.settled("PIUNSUPPORTED")
    let identity = ""
    await host.crash((database) => {
      identity = String(database.prepare("SELECT identity FROM runtime_store_schema").get()?.identity)
      database.prepare("UPDATE runtime_store_schema SET identity = 'an older build'").run()
    })
    const refused = await host.as(OWNER).fetch(`/session/${root}/message`)
    assert.equal(refused.status, 409)
    assert.deepEqual(await refused.json(), { error: { code: "session_host_unsupported_store", message: "This session's stored state was written by a build this one does not read" } })

    const database = new DatabaseSync(await host.sqlite())
    try { database.prepare("UPDATE runtime_store_schema SET identity = ?").run(identity) } finally { database.close() }
    assert.equal(assistantText(await host.messages()).includes("PIUNSUPPORTED"), true)

    await host.crash((stale) => { stale.prepare("UPDATE runtime_store_schema SET identity = 'an older build'").run() })
    assert.deepEqual(await host.json(`/session/${root}`, { method: "DELETE" }), { ok: true, deletedSessionIds: [root] })
    assert.deepEqual(host.controlPlane.calls.deletes, [OWNER])
    await host.crash()
    assert.deepEqual(await host.tables(), [])
  })

  void it("stops a turn whose plugin MCP server waits for a machine that is still provisioning", { timeout: 120_000 }, async () => {
    const root = "ses_mcp_wait"
    projection = { generation: "g2", pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "stdio", name: "waiting", origin: "plugin", command: process.execPath, args: ["-e", ""] }] }
    plugins = { harnessLaunch: { pi: { generation: "g2", execution: { mode: "default" }, pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "stdio", name: "waiting", origin: "plugin", command: "waiting" }] } }, mcp: {} }
    const host = await session(root)
    host.controlPlane.control.executionUnavailable = true
    await host.prompt("msg_mcp_wait", "Reply with exactly this one token: PIWAIT")
    await eventually("the MCP server waiting on the machine", async () => host.controlPlane.calls.executions.length >= 2 ? true : undefined, 30_000)
    const inspected = await host.json<{ target: { ownerGeneration: string } }>(`/session/${root}/recovery`)
    const waited = host.controlPlane.calls.executions.length
    await host.json(`/session/${root}/recovery`, { method: "POST", body: {
      requestId: "stop_wait", action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1,
    } })
    assert.ok(host.controlPlane.calls.executions.length - waited <= 1, `${host.controlPlane.calls.executions.length - waited} more waits after the stop`)
    await eventually("the stopped turn's lease released", async () => host.controlPlane.calls.releases.includes("msg_mcp_wait") ? true : undefined, 15_000)
    assert.equal(assistantText(await host.messages()).includes("PIWAIT"), false)
  })
})
