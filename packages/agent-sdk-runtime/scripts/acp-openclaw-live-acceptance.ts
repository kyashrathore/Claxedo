/** Opt-in bridge acceptance; add --prompt for one tiny turn on the gateway's configured model. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { AcpHarnessAdapter } from "../src/harnesses/acp/index"
import { SqliteRuntimeStore } from "../src/stores/sqlite"
import { waitForACPTransportRetirement } from "../src/harnesses/acp/transport"

const command = process.argv[2]
assert(command && path.isAbsolute(command), "Supply an installed OpenClaw executable")
const root = mkdtempSync(path.join(tmpdir(), "claxedo-openclaw-acp-"))
const directory = path.join(root, "workspace")
mkdirSync(directory)
const harness = "acceptance-openclaw"
const sessionKey = `agent:main:claxedo-acp-acceptance-${randomUUID()}`
const connection = { kind: "process" as const, command, args: ["acp", "--session", sessionKey, "--no-prefix-cwd"], supportsMcpServers: false, sharedFilesystem: false, env: { OPENCLAW_STATE_DIR: path.join(root, "bridge-state"), OPENCLAW_CONFIG_PATH: path.join(root, "bridge-state", "openclaw.json"), ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN } : {}), ...(process.env.OPENCLAW_GATEWAY_PASSWORD ? { OPENCLAW_GATEWAY_PASSWORD: process.env.OPENCLAW_GATEWAY_PASSWORD } : {}) } }
let store = new SqliteRuntimeStore({ root: path.join(root, "store") })
let adapter = new AcpHarnessAdapter({ harness, store, connection })
try {
  const session = await adapter.createSession(directory, "OpenClaw ACP acceptance")
  const upstreamSessionId = store.getAgentSessionId(session.id)
  assert(upstreamSessionId)
  const binding = { sessionId: session.id, upstreamSessionId, directory, workspaceId: "acceptance", connectionId: harness }
  const capabilities = await adapter.readHarnessCapabilities(directory, { sessionId: session.id })
  const options = await adapter.probeConfigOptions(directory, binding)
  console.log(JSON.stringify({ phase: "negotiated", root, sessionKey, capabilities, options }, null, 2))
  assert.equal(capabilities.modelSelection.status, "unsupported", "OpenClaw model controls must reflect its advertised capabilities")
  if (process.argv.includes("--prompt")) {
    const marker = `OPENCLAW_ACP_${randomUUID().replaceAll("-", "")}`
    for await (const event of adapter.executeTurn(binding, { parts: [{ type: "text", text: `Reply with only ${marker}. Do not use tools or access files.` }], userMessageId: randomUUID(), assistantMessageId: randomUUID() })) {
      assert.notEqual(event.type, "session.error", JSON.stringify(event))
      assert.notEqual(event.type, "permission.asked", "Tiny acceptance must not execute tools")
    }
    const text = store.getMessages(session.id).filter(row => row.info.role === "assistant").flatMap(row => row.parts).filter(part => part.type === "text").map(part => part.text).join("")
    assert(text.includes(marker), "The gateway must answer the real prompt")
  }
  if (process.argv.includes("--prompt")) {
    const history = JSON.stringify(store.getMessages(session.id))
    adapter.dispose()
    await waitForACPTransportRetirement(process.cwd(), connection)
    store.close()
    store = new SqliteRuntimeStore({ root: path.join(root, "store") })
    assert.equal(JSON.stringify(store.getMessages(session.id)), history)
    adapter = new AcpHarnessAdapter({ harness, store, connection })
    // This authorized session read forces restoration without submitting a prompt.
    await adapter.probeConfigOptions(directory, binding)
    assert.equal(store.getAgentSessionId(session.id), upstreamSessionId)
    console.log(JSON.stringify({ status: "passed", root, sessionKey, prompt: process.argv.includes("--prompt"), checks: ["real gateway-backed session", "truthful model capability", "SQLite reopen", "process restart and session restoration", "upstream identity preserved"] }, null, 2))
  } else {
    console.log(JSON.stringify({ status: "inspected", root, sessionKey, checks: ["real gateway-backed ACP creation", "truthful unsupported model selector"], unverified: ["model inference", "populated-session resume", "transcript reopen"] }, null, 2))
  }
} finally {
  adapter.dispose()
  await waitForACPTransportRetirement(process.cwd(), connection)
  store.close()
}
