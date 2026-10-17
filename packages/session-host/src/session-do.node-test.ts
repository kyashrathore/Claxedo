import { readField } from "@claxedo/helpers/readers"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, afterEach, before, describe, it } from "node:test"
import { generateKeyPair } from "jose"
import type { PluginProjection, RuntimeConfigSnapshotPlugins } from "@claxedo/harness/contract"
import { ORG_ACCOUNT_UNAVAILABLE, type ProviderUnavailable } from "@claxedo/agent-runtime-contract"
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

type StoredMessage = { info: { role: string; time?: { completed?: number } }; parts: Array<{ type: string; messageID?: string; text?: string; tool?: string; state?: { status?: string; output?: string; error?: string } }> }

const assistantText = (messages: StoredMessage[]) =>
  messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text ?? "").join("")

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A bash command that records its own OS pid, then runs until retired. Node's pid is the OS pid on every platform; Git Bash's `$$` is an MSYS pid. */
const holdCommand = (pidFile: string) =>
  `exec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60_000)' '${pidFile}'`

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

  const OPENAI_ACCOUNT = { credentialId: "cred_openai_owner", providerId: "openai", label: "owner's OpenAI key", revision: 3 }
  const openai = (secret: string) => ({ openai: { delivery: "direct" as const, baseUrl: model.url, apiPath: "/v1", secret, authKind: "api-key" as const, account: OPENAI_ACCOUNT } })

  async function session(root: string, options: { leaseTtlMs?: number; creator?: string; reservation?: string; accounts?: Record<string, ReturnType<typeof openai>>; refused?: Record<string, Record<string, ProviderUnavailable>> } = {}) {
    const creator = options.creator ?? OWNER
    const controlPlane = controlPlaneStandIn({
      root, relayHostKey: relayHost.publicKey, runtimeAccessKey: runtimeAccess.privateKey,
      accounts: () => options.accounts ?? { [OWNER]: openai(SECRET) }, ...(options.refused ? { refused: () => options.refused! } : {}), plugins: () => plugins, machine: () => ({ relayUrl: machine.relayUrl, directory }),
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

  void it("refuses a switch to Claude Code, which a cloud workspace runs in its runtime, telling the person to start a new session for it and leaving the session on Pi", { timeout: 120_000 }, async () => {
    const root = "ses_switch"
    const host = await session(root)
    const response = await host.as(OWNER).fetch(`/session/${root}/config`, {
      method: "PATCH", body: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: {
      code: "workspace_harness_hosted_elsewhere",
      message: "Claude Code runs in the workspace's runtime on a cloud workspace, not in this session's host. Start a new Claude Code session to use it here.",
    } })
    assert.deepEqual((await host.json<{ harness: unknown }>(`/session/${root}/config`)).harness, { id: "pi", access: "native" })
  })

  void it("a session in Ask mode asks before a write, writes on Allow once, blocks it on Deny, and keeps the mode across turns", { timeout: 120_000 }, async () => {
    const root = "ses_ask"
    const host = await session(root)
    type Permission = { id: string; sessionID: string; permission: string }
    const ask = async (marker: string, file: string, response: "once" | "reject") => {
      model.scriptTool({ name: "write", input: { path: file, content: `${marker}\n` }, whenPromptIncludes: marker })
      await host.json(`/session/${root}/prompt_async`, { method: "POST", body: {
        parts: [{ type: "text", text: `Write the file, then reply with exactly this one token: ${marker}` }], messageID: `msg_${marker}`, model: MODEL,
        ...(marker === "PIASKALLOW" ? { permissionMode: "ask" } : {}),
      } })
      const pending = await eventually(`the permission for ${marker}`, async () => {
        const open = await host.json<{ permissions?: { value?: Permission[] } | Permission[] }>(`/session/${root}?view=open`)
        const rows = Array.isArray(open.permissions) ? open.permissions : open.permissions?.value ?? []
        return rows.find((row) => row.sessionID === root)
      }, 30_000)
      assert.equal(existsSync(path.join(directory, file)), false, "nothing is written before the person answers")
      assert.equal(pending.permission, "write")
      await host.json(`/session/${root}/permissions/${encodeURIComponent(pending.id)}`, { method: "POST", body: { response } })
      return (await host.settled(marker)).flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.messageID === `msg_${marker}_r`)?.state
    }
    const allowed = await ask("PIASKALLOW", "ask-allowed.txt", "once")
    assert.equal(allowed?.status, "completed", JSON.stringify(allowed))
    assert.equal(await readFile(path.join(directory, "ask-allowed.txt"), "utf8"), "PIASKALLOW\n")
    assert.equal((await host.json<{ permissionMode?: string }>(`/session/${root}/config`)).permissionMode, "ask")

    const denied = await ask("PIASKDENY", "ask-denied.txt", "reject")
    assert.equal(denied?.status, "error", JSON.stringify(denied))
    assert.equal(denied?.error, "Tool call blocked: The person denied this tool call")
    assert.equal(existsSync(path.join(directory, "ask-denied.txt")), false)
  })

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

  void it("reports the turn's usage with the model's token counts, and its session row with the human turn and outcome, under the turn's lease once it ends", { timeout: 120_000 }, async () => {
    const root = "ses_reported"
    const host = await session(root)
    const sentAt = Date.now()
    await host.prompt("msg_reported", "Reply with exactly this one token: PIREPORTED")
    await host.settled("PIREPORTED")
    await eventually("the turn's usage report and session row", async () =>
      host.controlPlane.calls.usage.length && host.controlPlane.calls.rows.some((publication) => publication.rows.some((row) => row.lastTurn)) ? true : undefined)
    const facts = host.controlPlane.calls.usage.flatMap((report) => report.facts)
    const settled = facts.find((fact) => fact.settlement === "final")
    assert.ok(settled, JSON.stringify(facts))
    assert.deepEqual(host.controlPlane.calls.usage.map((report) => report.turnId), ["msg_reported"])
    assert.equal(settled.status, "completed")
    assert.equal(settled.harness, "pi")
    assert.equal(settled.providerId, "openai")
    assert.equal(settled.modelId, "gpt-4.1")
    assert.equal(settled.turnId, "msg_reported")
    assert.ok(atLeastOne(readField(settled.tokens, "input")) && atLeastOne(readField(settled.tokens, "output")), JSON.stringify(settled))
    assert.equal(readField(settled.quality, "source"), "provider")
    const final = host.controlPlane.calls.rows.at(-1)!
    assert.equal(final.turnId, "msg_reported")
    assert.equal(final.hostId, `session-do:${root}`)
    const row = final.rows.find((candidate) => candidate.sessionId === root)
    const lastHumanTurnAt = readField(row, "lastHumanTurnAt")
    assert.ok(typeof lastHumanTurnAt === "number" && lastHumanTurnAt >= sentAt, JSON.stringify(row))
    assert.equal(readField(readField(row, "status"), "kind"), "idle")
    assert.equal(readField(readField(row, "lastTurn"), "status"), "completed")
    assert.ok(typeof readField(row, "createdAt") === "number" && typeof readField(row, "updatedAt") === "number")
  })

  void it("reports the turn's first output when the model streamed its first text, not when the answer completed", { timeout: 120_000 }, async () => {
    const root = "ses_first_output"
    const host = await session(root)
    const pacing = { chunks: 4, delayMs: 400 }
    model.setTextStreamPacing(pacing)
    try {
      await host.prompt("msg_first_output", "Reply with exactly this one token: PIFIRSTOUTPUTSTREAMED")
      await host.settled("PIFIRSTOUTPUTSTREAMED")
    } finally { model.setTextStreamPacing(undefined) }
    const settled = await eventually("the turn's settled usage", async () =>
      host.controlPlane.calls.usage.flatMap((report) => report.facts).find((fact) => fact.settlement === "final"))
    const firstOutputAt = readField(settled, "firstOutputAt")
    const completedAt = readField(settled, "completedAt")
    assert.ok(typeof firstOutputAt === "number" && typeof completedAt === "number", JSON.stringify(settled))
    assert.ok(completedAt - firstOutputAt >= pacing.delayMs, JSON.stringify({ firstOutputAt, completedAt }))
  })

  void it("reports the stored account the vendor refused, under the turn's lease, and the failed turn's row and usage", { timeout: 120_000 }, async () => {
    const root = "ses_refused_account"
    const host = await session(root)
    const restore = model.scriptError({ marker: "PIREFUSEDKEY", status: 401, message: "Incorrect API key provided" })
    try {
      await host.prompt("msg_refused_key", "Reply with exactly this one token: PIREFUSEDKEY")
      await eventually("the refused account reported", async () => host.controlPlane.calls.refusals.length ? true : undefined, 30_000)
    } finally { restore() }
    assert.deepEqual(host.controlPlane.calls.refusals, [{ turnId: "msg_refused_key", credentialId: OPENAI_ACCOUNT.credentialId, revision: 3, status: 401 }])
    await eventually("the failed turn's row and usage", async () =>
      host.controlPlane.calls.usage.some((report) => report.turnId === "msg_refused_key")
        && host.controlPlane.calls.rows.some((publication) => publication.rows.some((row) => readField(row.lastTurn, "status") === "failed")) ? true : undefined)
    const fact = host.controlPlane.calls.usage.flatMap((report) => report.facts).find((candidate) => candidate.turnId === "msg_refused_key")
    assert.equal(fact?.status, "error", JSON.stringify(fact))
  })

  void it("reports nothing against the account for a vendor answer that is not 401, whatever its prose says about the key", { timeout: 120_000 }, async () => {
    const root = "ses_forbidden_account"
    const host = await session(root)
    const restore = model.scriptError({ marker: "PIFORBIDDENKEY", status: 403, message: "This API key is not allowed from your region" })
    try {
      await host.prompt("msg_forbidden_key", "Reply with exactly this one token: PIFORBIDDENKEY")
      await eventually("the forbidden turn's row", async () =>
        host.controlPlane.calls.rows.some((publication) => publication.rows.some((row) => readField(row.lastTurn, "status") === "failed")) ? true : undefined, 30_000)
    } finally { restore() }
    assert.deepEqual(host.controlPlane.calls.refusals, [])
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

  void it("answers a prompt sent again under a message id the session already holds as it first did, running it no second time, before and after the object restarts", { timeout: 120_000 }, async () => {
    const root = "ses_lost_ack"
    const host = await session(root)
    const send = () => host.prompt("msg_lost_ack", "Reply with exactly this one token: PILOSTACK")
    const first = await send()
    await host.settled("PILOSTACK")
    await eventually("the lost ack turn's lease released", async () => host.controlPlane.calls.releases.includes("msg_lost_ack") ? true : undefined)
    assert.deepEqual(await send(), first)
    await host.crash()
    assert.deepEqual(await send(), first)
    await host.prompt("msg_after_lost_ack", "Reply with exactly this one token: PIAFTERLOSTACK")
    await host.settled("PIAFTERLOSTACK")
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_lost_ack", "msg_after_lost_ack"])
  })

  void it("stops a turn and the command it was running on the machine", { timeout: 120_000 }, async () => {
    const root = "ses_stop"
    const host = await session(root)
    const pidFile = path.join(directory, "stop.pid")
    model.scriptTool({ name: "bash", input: { command: holdCommand(pidFile) }, whenPromptIncludes: "PISTOP" })
    await host.prompt("msg_stop", "Run it, then reply with exactly this one token: PISTOP")
    const pid = await pidFrom(pidFile)
    assert.equal(pidAlive(pid), true)
    const inspected = await host.json<{ target: { ownerGeneration: string } }>(`/session/${root}/recovery`)
    await host.json(`/session/${root}/recovery`, { method: "POST", body: {
      requestId: "stop_1", action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1,
    } })
    await eventually(`the held command ${pid} retired`, async () => pidAlive(pid) ? undefined : true, 15_000)
    assert.equal(assistantText(await host.messages()).includes("PISTOP"), false)
  })

  void it("runs a message queued behind a turn once that turn is stopped, under its own turn id", { timeout: 120_000 }, async () => {
    const root = "ses_stop_queued"
    const host = await session(root)
    const pidFile = path.join(directory, "stop-queued.pid")
    model.scriptTool({ name: "bash", input: { command: holdCommand(pidFile) }, whenPromptIncludes: "PISTOPQUEUED" })
    await host.prompt("msg_stopped", "Run it, then reply with exactly this one token: PISTOPQUEUED")
    const pid = await pidFrom(pidFile)
    assert.deepEqual(await host.json(`/session/${root}/prompt_async`, { method: "POST", body: {
      parts: [{ type: "text", text: "Reply with exactly this one token: PIQUEUEDAFTERSTOP" }], messageID: "msg_queued_after_stop", model: MODEL, delivery: "queue",
    } }), { delivery: "queue" })
    const inspected = await host.json<{ target: { ownerGeneration: string } }>(`/session/${root}/recovery`)
    await host.json(`/session/${root}/recovery`, { method: "POST", body: {
      requestId: "stop_queued", action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1,
    } })
    await eventually(`the held command ${pid} retired`, async () => pidAlive(pid) ? undefined : true, 15_000)
    await host.settled("PIQUEUEDAFTERSTOP").catch(async (error: unknown) => { throw new Error(`${String(error)}\nqueue: ${JSON.stringify(await host.json(`/session/${root}/queue`))}`) })
    assert.deepEqual(await host.json(`/session/${root}/queue`), [])
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_stopped", "msg_queued_after_stop"])
    assert.equal(assistantText(await host.messages()).includes("PISTOPQUEUED"), false)
  })

  void it("runs the messages queued behind a turn that ends by itself, in the order they were sent", { timeout: 120_000 }, async () => {
    const root = "ses_queued_after_turn"
    const host = await session(root)
    const pidFile = path.join(directory, "queued-after-turn.pid")
    const briefCommand = `exec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 3_000)' '${pidFile}'`
    model.scriptTool({ name: "bash", input: { command: briefCommand }, whenPromptIncludes: "PIBRIEFTURN" })
    await host.prompt("msg_brief", "Run it, then reply with exactly this one token: PIBRIEFTURN")
    await pidFrom(pidFile)
    for (const [messageID, token] of [["msg_queued_a", "PIQUEUEDA"], ["msg_queued_b", "PIQUEUEDB"]]) {
      assert.deepEqual(await host.json(`/session/${root}/prompt_async`, { method: "POST", body: {
        parts: [{ type: "text", text: `Reply with exactly this one token: ${token}` }], messageID, model: MODEL, delivery: "queue",
      } }), { delivery: "queue" })
    }
    await host.settled("PIQUEUEDB").catch(async (error: unknown) => { throw new Error(`${String(error)}\nqueue: ${JSON.stringify(await host.json(`/session/${root}/queue`))}`) })
    assert.deepEqual(await host.json(`/session/${root}/queue`), [])
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_brief", "msg_queued_a", "msg_queued_b"])
    assert.match(assistantText(await host.messages()), /PIBRIEFTURN[\s\S]*PIQUEUEDA[\s\S]*PIQUEUEDB/)
  })

  type QueueRow = { seq: number; messageId: string; steering?: { state: string } }
  const briefCommand = (pidFile: string) =>
    `exec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 3_000)' '${pidFile}'`
  const queueBehind = async (host: Awaited<ReturnType<typeof session>>, root: string, messageID: string, token: string) => {
    assert.deepEqual(await host.json(`/session/${root}/prompt_async`, { method: "POST", body: {
      parts: [{ type: "text", text: `Reply with exactly this one token: ${token}` }], messageID, model: MODEL, delivery: "queue",
    } }), { delivery: "queue" })
    const row = (await host.json<QueueRow[]>(`/session/${root}/queue`)).find((candidate) => candidate.messageId === messageID)
    assert.ok(row, `${messageID} was queued`)
    return row.seq
  }

  void it("steers a queued message into the running turn on Send now, taking no turn of its own", { timeout: 120_000 }, async () => {
    const root = "ses_send_now_busy"
    const host = await session(root)
    const pidFile = path.join(directory, "send-now-busy.pid")
    model.scriptTool({ name: "bash", input: { command: briefCommand(pidFile) }, whenPromptIncludes: "PISENDNOWBUSY" })
    await host.prompt("msg_send_now_busy", "Run it, then reply with exactly this one token: PISENDNOWBUSY")
    await pidFrom(pidFile)
    const seq = await queueBehind(host, root, "msg_sent_now", "PISTEEREDIN")
    const sent = await host.as(OWNER).fetch(`/session/${root}/queue/${seq}/steer`, { method: "POST", body: {} })
    const answer = await sent.text()
    assert.notEqual(sent.status, 409, answer)
    await host.settled("PISTEEREDIN")
    await eventually("the steered row leaving the queue", async () => (await host.json<QueueRow[]>(`/session/${root}/queue`)).length === 0 ? true : undefined)
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_send_now_busy"])
  })

  void it("runs a queued message the queue could not start on Retry, as its own turn under its own grant", { timeout: 120_000 }, async () => {
    const root = "ses_retry_idle"
    const host = await session(root)
    const pidFile = path.join(directory, "retry-idle.pid")
    model.scriptTool({ name: "bash", input: { command: briefCommand(pidFile) }, whenPromptIncludes: "PIRETRYFIRST" })
    await host.prompt("msg_retry_first", "Run it, then reply with exactly this one token: PIRETRYFIRST")
    await pidFrom(pidFile)
    host.controlPlane.control.refusedTurns.add("msg_retried")
    const seq = await queueBehind(host, root, "msg_retried", "PIRETRIED")
    await host.settled("PIRETRYFIRST")
    await eventually("the queue's start refused", async () =>
      (await host.json<QueueRow[]>(`/session/${root}/queue`))[0]?.steering?.state === "rejected" ? true : undefined, 30_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal((await host.json<QueueRow[]>(`/session/${root}/queue`))[0]?.steering?.state, "rejected")
    host.controlPlane.control.refusedTurns.delete("msg_retried")
    const retried = await host.as(OWNER).fetch(`/session/${root}/queue/${seq}/steer`, { method: "POST", body: {} })
    assert.deepEqual({ status: retried.status, body: await retried.json() }, { status: 200, body: { ok: true } })
    await host.settled("PIRETRIED").catch(async (error: unknown) => { throw new Error(`${String(error)}\nqueue: ${JSON.stringify(await host.json(`/session/${root}/queue`))}`) })
    assert.deepEqual(await host.json(`/session/${root}/queue`), [])
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_retry_first", "msg_retried"])
  })

  void it("runs a message queued behind a run the object took over after it restarted, once that run's lease is released", { timeout: 120_000 }, async () => {
    const root = "ses_evict_queued"
    const host = await session(root)
    const pidFile = path.join(directory, "evict-queued.pid")
    model.scriptTool({ name: "bash", input: { command: holdCommand(pidFile) }, whenPromptIncludes: "PIEVICTQUEUED" })
    await host.prompt("msg_evict_queued", "Run it, then reply with exactly this one token: PIEVICTQUEUED")
    const pid = await pidFrom(pidFile)
    await queueBehind(host, root, "msg_after_evict", "PIAFTEREVICT")
    host.controlPlane.control.releaseDelayMs = 1_500
    await host.crash()
    await eventually(`the held command ${pid} retired with the lost object`, async () => pidAlive(pid) ? undefined : true, 15_000)
    await host.settled("PIEVICTQUEUED")
    await host.settled("PIAFTEREVICT").catch(async (error: unknown) => { throw new Error(`${String(error)}\nqueue: ${JSON.stringify(await host.json(`/session/${root}/queue`))}`) })
    assert.deepEqual(await host.json(`/session/${root}/queue`), [])
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_evict_queued", "msg_evict_queued", "msg_after_evict"])
    assert.ok(host.controlPlane.calls.releases.indexOf("msg_evict_queued") >= 0)
  })

  void it("takes a message sent between a turn's answer and its lease's release, and runs it once the lease is released", { timeout: 120_000 }, async () => {
    const root = "ses_send_in_release_gap"
    const host = await session(root)
    host.controlPlane.control.releaseDelayMs = 1_500
    await host.prompt("msg_gap_first", "Reply with exactly this one token: PIGAPFIRST")
    await host.settled("PIGAPFIRST")
    assert.equal(host.controlPlane.calls.releases.includes("msg_gap_first"), false)
    await host.prompt("msg_gap_next", "Reply with exactly this one token: PIGAPNEXT")
    await host.settled("PIGAPNEXT")
    assert.deepEqual(host.controlPlane.calls.deliveries, ["msg_gap_first", "msg_gap_next"])
    assert.deepEqual(host.controlPlane.calls.releases.slice(0, 1), ["msg_gap_first"])
  })

  void it("draws every turn's tool rows in the first read a reload takes, as the live stream showed them, after the object restarts", { timeout: 120_000 }, async () => {
    const root = "ses_reload_tools"
    const host = await session(root)
    const pidFile = path.join(directory, "reload-tools.pid")
    model.scriptTool({ name: "bash", input: { command: "echo RELOADTOOL" }, whenPromptIncludes: "PIRELOADTOOL" })
    await host.prompt("msg_reload_tool", "Run it, then reply with exactly this one token: PIRELOADTOOL")
    await host.settled("PIRELOADTOOL")
    model.scriptTool({ name: "bash", input: { command: holdCommand(pidFile) }, whenPromptIncludes: "PIRELOADSTOP" })
    await host.prompt("msg_reload_stop", "Run it, then reply with exactly this one token: PIRELOADSTOP")
    const pid = await pidFrom(pidFile)
    const inspected = await host.json<{ target: { ownerGeneration: string } }>(`/session/${root}/recovery`)
    await host.json(`/session/${root}/recovery`, { method: "POST", body: {
      requestId: "stop_reload_tools", action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1,
    } })
    await eventually(`the held command ${pid} retired`, async () => pidAlive(pid) ? undefined : true, 15_000)
    await host.prompt("msg_reload_text", "Reply with exactly this one token: PIRELOADTEXT")
    await host.settled("PIRELOADTEXT")
    const toolRows = (messages: StoredMessage[]) => messages.flatMap((message) => message.parts).filter((part) => part.type === "tool").map((part) => [part.tool, part.state?.status])
    const expected = [["bash", "completed"], ["bash", "error"]]
    assert.deepEqual(toolRows(await host.messages()), expected, JSON.stringify(await host.messages()))
    await host.crash()
    const first = await host.json<{ page: { turns: Array<{ messages: StoredMessage[] }> } }>(`/session/${root}/outline?rows=40&cols=120&reasoning=0&shell=0&edit=0`)
    assert.deepEqual(toolRows(first.page.turns.flatMap((turn) => turn.messages)), expected, JSON.stringify(first))
  })

  void it("resumes a run lost mid-tool when Pi's wake alarm restarts the object, under the lease it took over", { timeout: 120_000 }, async () => {
    const root = "ses_evict"
    const host = await session(root)
    const pidFile = path.join(directory, "evict.pid")
    model.scriptTool({ name: "bash", input: { command: holdCommand(pidFile) }, whenPromptIncludes: "PIEVICT" })
    await host.prompt("msg_evict", "Run it, then reply with exactly this one token: PIEVICT")
    const pid = await pidFrom(pidFile)
    const answeredBefore = model.requests.length
    await host.crash()
    await eventually(`the held command ${pid} retired with the lost object`, async () => pidAlive(pid) ? undefined : true, 15_000)
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
    model.scriptTool({ name: "bash", input: { command: holdCommand(pidFile) }, whenPromptIncludes: "PIREFUSED" })
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
    const proof = messages.flatMap((message) => message.parts).find((part) => part.tool === "mcp__machine__proof")
    assert.equal(proof?.state?.output, `MACHINE_MCP:M1:${directory}`, JSON.stringify(messages))
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
    assert.match(refused, /No account is chosen for this harness/)
    assert.equal(model.requests.slice(answered).some((request) => request.prompt.includes("PIBARE")), false)
  })

  void it("a creator who chose the organization's account where it has none is told that, and spends nothing", { timeout: 120_000 }, async () => {
    const creator = "user_org_source"
    const host = await session("ses_org_source", { creator, accounts: {}, refused: { [creator]: { openai: { unavailable: true, reason: ORG_ACCOUNT_UNAVAILABLE } } } })
    const answered = model.requests.length
    await host.prompt("msg_org_source", "Reply with exactly this one token: PIORGSOURCE")
    const refused = await eventually("the turn refused for the organization's missing account", async () => {
      const reply = (await host.messages()).find((message) => message.info.role === "assistant" && message.info.time?.completed)
      return reply ? JSON.stringify(reply.info) : undefined
    }, 30_000)
    assert.match(refused, /Your organization has no OpenAI API key, .*Ask an owner or admin to add an organization account in Settings → Models/)
    assert.equal(model.requests.slice(answered).some((request) => request.prompt.includes("PIORGSOURCE")), false)
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
    const after = await host.as(OWNER).fetch(`/session/${root}/message`)
    assert.equal(after.status, 404)
    assert.deepEqual(await after.json(), { error: { code: "session_deleted", message: "This session was deleted" } })
    assert.deepEqual(await host.tables(), [])
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

  const NO_PLUGINS: RuntimeConfigSnapshotPlugins = { harnessLaunch: {}, mcp: {} }
  const toolParts = (messages: StoredMessage[], tool: string) => messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === tool)

  void it("answers a turn while the workspace machine sleeps, without starting it or asking for it", { timeout: 120_000 }, async () => {
    plugins = NO_PLUGINS
    const host = await session("ses_asleep_text")
    host.controlPlane.control.machine = "asleep"
    await host.prompt("msg_asleep_text", "Reply with exactly this one token: PIASLEEPTEXT")
    await host.settled("PIASLEEPTEXT")
    assert.deepEqual(host.controlPlane.calls.starts, [])
    assert.deepEqual(host.controlPlane.calls.executions, [])
  })

  const writeTool = (host: Awaited<ReturnType<typeof session>>) => async (marker: string) => {
    model.scriptTool({ name: "write", input: { path: "asleep.txt", content: `${marker}\n` }, whenPromptIncludes: marker })
    await host.prompt(`msg_${marker}`, `Write the file, then reply with exactly this one token: ${marker}`)
    return toolParts(await host.settled(marker), "write").at(-1)?.state
  }

  void it("a tool call that starts a sleeping machine holds while it comes up, asking again only as often as the start answers, and runs the tool once it runs", { timeout: 120_000 }, async () => {
    plugins = NO_PLUGINS
    const host = await session("ses_asleep_hold")
    const control = host.controlPlane.control
    control.machine = "asleep"
    control.start = { retryAfterMs: 500, sinceStartMs: 1_000 }
    const written = path.join(directory, "asleep.txt")
    await rm(written, { force: true })
    const heldSince = Date.now()
    const ran = writeTool(host)("PIASLEEPHELD")
    await eventually("the machine start", async () => host.controlPlane.calls.starts.length === 1 || undefined, 30_000)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    control.machine = "running"
    const state = await ran
    const held = Date.now() - heldSince
    assert.equal(state?.status, "completed", JSON.stringify(state))
    assert.equal(await readFile(written, "utf8"), "PIASLEEPHELD\n")
    assert.deepEqual(host.controlPlane.calls.starts, ["msg_PIASLEEPHELD"])
    const asks = host.controlPlane.calls.executions.filter((turn) => turn === "msg_PIASLEEPHELD").length
    assert.ok(asks >= 3 && asks <= 2 + held / 500, `${asks} asks in ${held} ms`)
    assert.equal(model.requests.some((request) => request.prompt.includes("This tool call started the asleep workspace machine")), false, "the model never read that the machine was starting")
  })

  void it("stopping a turn while its tool call holds for a starting machine ends the hold, and the call asks for the machine no more", { timeout: 120_000 }, async () => {
    plugins = NO_PLUGINS
    const root = "ses_asleep_stop"
    const host = await session(root)
    const control = host.controlPlane.control
    control.machine = "asleep"
    control.start = { retryAfterMs: 500, sinceStartMs: 1_000 }
    model.scriptTool({ name: "write", input: { path: "asleep-stop.txt", content: "no\n" }, whenPromptIncludes: "PIASLEEPSTOP" })
    await host.prompt("msg_PIASLEEPSTOP", "Write the file, then reply with exactly this one token: PIASLEEPSTOP")
    await eventually("the machine start", async () => host.controlPlane.calls.starts.length === 1 || undefined, 30_000)
    const inspected = await host.json<{ target: { ownerGeneration: string } }>(`/session/${root}/recovery`)
    const stoppedAt = Date.now()
    await host.json(`/session/${root}/recovery`, { method: "POST", body: {
      requestId: "stop_hold", action: "cancel_turn", target: inspected.target, scopeRevision: inspected.target.ownerGeneration, attempt: 1,
    } })
    await eventually("the held tool call ended", async () => {
      const state = toolParts(await host.messages(), "write").at(-1)?.state
      return state && state.status !== "running" && state.status !== "pending" ? state : undefined
    }, 15_000)
    assert.ok(Date.now() - stoppedAt < 10_000, `the hold ended ${Date.now() - stoppedAt} ms after the stop`)
    const asks = host.controlPlane.calls.executions.length
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.equal(host.controlPlane.calls.executions.length, asks)
    assert.equal(existsSync(path.join(directory, "asleep-stop.txt")), false)
  })

  void it("a tool call whose machine start failed answers at once that it could not start, why, and when it can be tried again, with no hold and no call-again", { timeout: 120_000 }, async () => {
    plugins = NO_PLUGINS
    const host = await session("ses_asleep_refused")
    const control = host.controlPlane.control
    control.machine = "asleep"
    control.startRefusal = { message: "The cloud workspace could not start: boat_rate_limited: 429 Too Many Requests", retryAfterMs: 30_000 }
    const asked = Date.now()
    const state = await writeTool(host)("PIASLEEPREFUSED")
    assert.equal(state?.status, "error", JSON.stringify(state))
    assert.equal(state?.error, "The cloud workspace could not start: boat_rate_limited: 429 Too Many Requests; try again in about 30 s.")
    assert.ok(Date.now() - asked < 15_000)
    assert.equal(host.controlPlane.calls.executions.filter((turn) => turn === "msg_PIASLEEPREFUSED").length, 1)
  })

  void it("a tool call whose machine is not up within its hold answers that this call started it and how long it has been starting, starts it no second time, and runs the tool once it runs", { timeout: 120_000 }, async () => {
    plugins = NO_PLUGINS
    const host = await session("ses_asleep_tool")
    const control = host.controlPlane.control
    control.machine = "asleep"
    const written = path.join(directory, "asleep.txt")
    await rm(written, { force: true })
    const write = writeTool(host)

    const started = await write("PIASLEEPSTART")
    assert.equal(started?.status, "error", JSON.stringify(started))
    assert.ok(started?.error?.includes("This tool call started the asleep workspace machine; call this tool again to wait up to 20 s for it."), started?.error)
    assert.ok(model.requests.some((request) => request.prompt.includes("This tool call started the asleep workspace machine")), "the model was told the machine is starting")
    assert.deepEqual(host.controlPlane.calls.starts, ["msg_PIASLEEPSTART"])
    assert.equal(existsSync(written), false)

    const starting = await write("PIASLEEPSTARTING")
    assert.equal(starting?.status, "error", JSON.stringify(starting))
    assert.ok(starting?.error?.includes("The workspace machine is still starting (35 s so far); call this tool again to wait up to 20 s for it."), starting?.error)
    assert.deepEqual(host.controlPlane.calls.starts, ["msg_PIASLEEPSTART"])

    control.machine = "running"
    const ran = await write("PIASLEEPRAN")
    assert.equal(ran?.status, "completed", JSON.stringify(ran))
    assert.equal(await readFile(written, "utf8"), "PIASLEEPRAN\n")
    assert.deepEqual(host.controlPlane.calls.starts, ["msg_PIASLEEPSTART"])
  })

  void it("leaves the skills section out while the machine sleeps without starting it, and reads it from the machine once it runs", { timeout: 120_000 }, async () => {
    const skills = path.join(directory, "skill-plugin")
    await mkdir(path.join(skills, "skills", "probe"), { recursive: true })
    await writeFile(path.join(skills, "skills", "probe", "SKILL.md"), "---\nname: probe\ndescription: PROBESKILLDESCRIPTION\n---\nProbe.\n")
    plugins = { harnessLaunch: { pi: { generation: "skills", execution: { mode: "default" }, notApplied: [], mcpServers: [],
      pluginRoots: [{ pluginInstanceId: "pi_skill_plugin", root: skills, dataRoot: skills, skillNames: ["probe"] }] } }, mcp: {} }
    try {
      const host = await session("ses_asleep_skills")
      host.controlPlane.control.machine = "asleep"
      await host.prompt("msg_asleep_skills", "Reply with exactly this one token: PIASLEEPSKILLS")
      await host.settled("PIASLEEPSKILLS")
      assert.deepEqual(host.controlPlane.calls.starts, [])
      const asleep = model.requests.filter((request) => request.prompt.includes("PIASLEEPSKILLS"))
      assert.ok(asleep.length > 0 && asleep.every((request) => !request.prompt.includes("PROBESKILLDESCRIPTION")))

      host.controlPlane.control.machine = "running"
      await host.prompt("msg_awake_skills", "Reply with exactly this one token: PIAWAKESKILLS")
      await host.settled("PIAWAKESKILLS")
      assert.ok(model.requests.some((request) => request.prompt.includes("PIAWAKESKILLS") && request.prompt.includes("PROBESKILLDESCRIPTION")))
    } finally {
      plugins = NO_PLUGINS
    }
  })

  void it("starts a sleeping machine for a plugin's stdio MCP server, answers the turn without that server's tools, and lists them once the machine runs", { timeout: 120_000 }, async () => {
    const server = path.join(directory, "asleep-mcp.cjs")
    await writeFile(server, STDIO_MCP)
    projection = { generation: "g-asleep", pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "stdio", name: "machine", origin: "plugin", command: process.execPath, args: [server] }] }
    plugins = { harnessLaunch: { pi: { generation: "g-asleep", execution: { mode: "default" }, pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "stdio", name: "machine", origin: "plugin", command: "machine" }] } }, mcp: {} }
    try {
      const host = await session("ses_asleep_mcp")
      const control = host.controlPlane.control
      control.machine = "asleep"
      await host.prompt("msg_asleep_mcp", "Reply with exactly this one token: PIASLEEPMCP")
      await host.settled("PIASLEEPMCP")
      assert.deepEqual(host.controlPlane.calls.starts, ["msg_asleep_mcp"])
      const offered = (marker: string) => model.requests.find((request) => request.prompt.includes(marker))?.tools.map((tool) => tool.name) ?? []
      assert.equal(offered("PIASLEEPMCP").includes("mcp__machine__proof"), false)

      control.machine = "running"
      model.scriptTool({ name: "mcp__machine__proof", input: { marker: "M2" }, whenPromptIncludes: "PIAWAKEMCP" })
      await host.prompt("msg_awake_mcp", "Call it, then reply with exactly this one token: PIAWAKEMCP")
      const proof = toolParts(await host.settled("PIAWAKEMCP"), "mcp__machine__proof").at(-1)
      assert.equal(proof?.state?.output, `MACHINE_MCP:M2:${directory}`, JSON.stringify(await host.messages()))
      assert.deepEqual(host.controlPlane.calls.starts, ["msg_asleep_mcp"])
    } finally {
      plugins = NO_PLUGINS
    }
  })
})


function atLeastOne(value: unknown) {
  return typeof value === "number" && value >= 1
}
