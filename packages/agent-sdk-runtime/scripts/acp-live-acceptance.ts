/** Opt-in subscription-backed acceptance: bun scripts/acp-live-acceptance.ts /absolute/path/to/codex-acp */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AcpHarnessAdapter } from "../src/harnesses/acp/index"
import { SqliteRuntimeStore } from "../src/stores/sqlite"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"

const command = process.argv[2]
assert(command && path.isAbsolute(command), "Supply the absolute path to an installed Codex ACP executable")
const root = mkdtempSync(path.join(tmpdir(), "claxedo-acp-acceptance-"))
const directory = path.join(root, "workspace")
// Codex permits workspace and OS-temp writes without approval. Use a fresh,
// dedicated home-directory fixture to exercise an actual approval boundary.
const permissionRoot = mkdtempSync(path.join(homedir(), ".claxedo-acp-permission-"))
const permissionFile = path.join(permissionRoot, "acceptance.txt")
mkdirSync(directory)
const harness = "acceptance-codex-acp"
const model = { providerID: `connection:${harness}`, modelID: "gpt-5.6-luna" }
const marker = `ACP_${randomUUID().replaceAll("-", "")}`
let store = new SqliteRuntimeStore({ root: path.join(root, "store") })
const connect = () => new AcpHarnessAdapter({
  harness, store,
  // Native child tools require Codex's v2 feature as well as ACP negotiation.
  // This applies only to this disposable acceptance connection.
  connection: { kind: "process", command, sharedFilesystem: true,
    env: { CODEX_CONFIG: JSON.stringify({ features: { multi_agent: true, multi_agent_v2: true } }) },
  },
})
let adapter = connect()
function binding(sessionId: string): AgentExecutionBinding {
  const upstreamSessionId = store.getAgentSessionId(sessionId)
  assert(upstreamSessionId)
  return { sessionId, upstreamSessionId, workspaceId: "acceptance", connectionId: harness, directory }
}
let approvedPermissions = 0
async function prompt(sessionId: string, text: string, permissionMode?: string) {
  const previous = store.getMessages(sessionId).length
  const events: string[] = []
  for await (const event of adapter.executeTurn(binding(sessionId), {
    parts: [{ type: "text", text }], userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    model, variant: "low", ...(permissionMode ? { permissionMode } : {}),
  })) {
    events.push(event.type)
    if (event.type === "permission.asked") {
      assert.equal(permissionMode, "read-only", "Unexpected permission request outside the explicit file-write acceptance")
      assert.equal(event.properties.sessionID, sessionId)
      assert(store.listPermissions(directory).some(row => row.id === event.properties.id), "Permission must be durable before it is exposed to the client")
      await adapter.respondPermission(binding(sessionId), event.properties.id, "allow_once")
      approvedPermissions += 1
    }
  }
  assert(events.includes("session.idle"), "Turn must terminate through the public event stream")
  const messages = store.getMessages(sessionId).slice(previous)
  assert(!messages.some(message => message.info.role === "assistant" && message.info.error), "Turn must not contain an assistant error")
  return messages.filter(message => message.info.role === "assistant")
    .flatMap(message => message.parts).filter(part => part.type === "text").map(part => part.text).join("")
}
try {
  const first = await adapter.createSession(directory, "ACP persistence acceptance")
  const options = await adapter.probeConfigOptions(directory)
  assert(options.options.some(option => option.category === "model" && JSON.stringify(option).includes(model.modelID)), "Luna must be advertised before spending subscription usage")
  await adapter.updateSessionConfig(binding(first.id), { model, variant: "low" })
  assert((await prompt(first.id, `Remember this marker: ${marker}. Reply with that exact marker. Do not use tools.`)).includes(marker))
  const upstream = store.getAgentSessionId(first.id)
  const persisted = JSON.stringify(store.getMessages(first.id))
  adapter.dispose()
  store.close()
  store = new SqliteRuntimeStore({ root: path.join(root, "store") })
  assert.equal(JSON.stringify(store.getMessages(first.id)), persisted, "Claxedo transcript must survive store reopening exactly")
  adapter = connect()
  assert((await prompt(first.id, "What exact marker did I ask you to remember? Reply with just the marker, without using tools.")).includes(marker), "Agent must remember context after process recreation")
  assert.equal(store.getAgentSessionId(first.id), upstream, "Resume must preserve upstream identity")
  const sibling = await adapter.createSession(directory, "ACP sibling acceptance")
  await adapter.updateSessionConfig(binding(sibling.id), { model, variant: "low" })
  await assert.rejects(adapter.updateSessionConfig(binding(first.id), {
    model: { ...model, modelID: "claxedo-intentionally-unavailable-model" },
  }))
  assert((await prompt(sibling.id, "Reply exactly ACP_SIBLING_OK. Do not use tools.")).includes("ACP_SIBLING_OK"), "Rejected configuration must leave sibling usable")
  await prompt(sibling.id, `Create ${permissionFile} containing exactly ACP_PERMISSION_OK. This is an explicitly authorized disposable acceptance fixture outside the workspace; request permission for the write. Do not read or modify other files or use network access.`, "read-only")
  assert.equal(readFileSync(permissionFile, "utf8").trim(), "ACP_PERMISSION_OK")
  assert(approvedPermissions > 0, "Real agent must request permission, not bypass the acceptance flow")
  assert.equal(store.listPermissions(directory).length, 0, "Answered permission must leave no pending interaction")
  const childMarker = "ACP_CHILD_" + randomUUID().replaceAll("-", "")
  await prompt(sibling.id, `Use exactly one subagent to reply with ${childMarker}. While it works, independently compute 17+25, then wait for that subagent and report both results. Do not read or modify files or use network access. Use the same inexpensive model and low reasoning.`)
  const children = store.listSessions(directory).filter(session => session.parentID === sibling.id)
  assert(children.length > 0, "Native subagent must have a canonical child session")
  assert(children.some(child => store.getMessages(child.id).some(message => message.parts.some(part => part.type === "text" && part.text.includes(childMarker)))), "Child output must be preserved in its own transcript")
  console.log(JSON.stringify({ status: "passed", root, model: model.modelID, reasoning: "low", approvedPermissions, children: children.length, checks: ["live prompt", "SQLite transcript reopen", "process restart and agent resume", "upstream identity preserved", "invalid model rejected", "sibling prompt after rejection", "durable permission and allow-once file write", "native child identity and transcript"] }, null, 2))
} finally {
  adapter.dispose()
  store.close()
  rmSync(permissionRoot, { recursive: true, force: true })
}
