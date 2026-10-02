import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "../harness/api"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

async function heldModel(stack: Awaited<ReturnType<typeof startStack>>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([stack.scripted.textGateReached("H10LIVEPERMISSIONS"), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Claude never reached the live permission gate\n${stack.daemon.log()}`)), 30_000)
    })])
  } finally { clearTimeout(timeout) }
}

export async function claudeLivePermissions() {
  const stack = await startStack({ label: "h10-live-permissions" })
  let release = () => {}
  try {
    const api = new ClaxedoApi(stack.url)
    const { directory } = await stack.daemon.makeWorkspace("h10-live-permissions")
    const stream = await stack.events(directory)
    const output = path.join(stack.dataDir, "live-permissions-output")
    await fs.mkdir(output, { mode: 0o700 })
    const session = await api.createSession(directory, { harness: { id: "claude", access: "native" },
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-6" }, permissionMode: "default", title: "H10 live permissions" })
    release = stack.scripted.holdOpeningReplies("H10LIVEPERMISSIONS")
    stack.scripted.scriptTool({ name: "Bash", whenPromptIncludes: "H10LIVEPERMISSIONS", input: { command: `chmod -R 755 '${output}'` } })
    await api.promptAsync(directory, session.id, "Run the Bash command H10LIVEPERMISSIONS")
    await heldModel(stack)
    const kept = await api.setPermissionMode(directory, session.id, "bypassPermissions")
    assert.equal(kept.currentModeId, "bypassPermissions")
    assert.equal(kept.appliesFrom, "immediate")
    assert.equal((await api.permissionMode(directory, session.id)).currentModeId, "bypassPermissions")
    release()
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
      { label: "Claude live permission turn idle", timeoutMs: 60_000 })
    assert.equal((await fs.stat(output)).mode & 0o777, 0o755)
    assert.equal(stream.frames.some((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === session.id), false)
    console.log("H10 Claude: the public permission setter changes the active turn before its next tool")
  } finally { release(); await stack.close() }
}
