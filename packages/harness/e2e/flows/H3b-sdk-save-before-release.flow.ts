import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, type PermissionRow } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { refusePermissionReplySave, refusedAsUnsaved } from "../harness/refuse-permission-save"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

const HARNESSES = [
  { id: "claude", providerId: "anthropic", modelId: "claude-sonnet-4-5", tool: "Bash", permissionMode: "default" },
  { id: "codex", providerId: "openai", modelId: "gpt-4.1", tool: "exec_command", permissionMode: "workspace-write" },
] as const

async function pending(api: ClaxedoApi, stream: EventStream, directory: string, sessionId: string, diagnostics: () => unknown): Promise<PermissionRow> {
  await stream.waitFor((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === sessionId,
    { label: `permission for ${sessionId}`, timeoutMs: 30_000 })
  const request = (await api.permissions(directory)).find((row) => row.sessionID === sessionId)
  if (request) return request
  throw new Error(`${sessionId} did not retain permission after permission.asked: ${JSON.stringify(diagnostics())}; messages ${JSON.stringify(await api.messages(directory, sessionId))}`)
}

export async function run() {
  const stack = await startStack({ label: "h3b-sdk-save-before-release" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h3b-sdk-save-before-release")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    for (const harness of HARNESSES) {
      const marker = `H3B_${harness.id.toUpperCase()}`
      const output = path.join(stack.dataDir, `${harness.id}-outside-workspace.txt`)
      const command = `printf approved > '${output}'`
      const input = harness.id === "claude"
        ? { command, description: "Write the isolated approval test file" }
        : { cmd: command, sandbox_permissions: "require_escalated", justification: "Write the isolated approval test file" }
      stack.scripted.scriptTool({ name: harness.tool, input, whenPromptIncludes: marker })
      const session = await api.createSession(directory, { harness: { id: harness.id, access: "native" },
        permissionMode: harness.permissionMode, model: { providerId: harness.providerId, modelId: harness.modelId } })
      await api.promptAsync(directory, session.id, `Run the requested command, then reply with exactly this one token: ${marker}`)
      const request = await pending(api, stream, directory, session.id, () => ({
        counts: stack.scripted.counts(), egress: stack.egress.attempts, log: stack.daemon.log().slice(-3000),
      }))
      assert.ok(stream.frames.some((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === session.id))
      const beforeMessages = await api.messages(directory, session.id)
      const release = await refusePermissionReplySave(stack.dataDir, session.id)
      try {
        await assert.rejects(() => api.replyPermission(directory, session.id, request.id, "once"),
          (error: unknown) => refusedAsUnsaved(error, `H3b ${harness.id}`))
        assert.ok((await api.permissions(directory)).some((row) => row.id === request.id), `${harness.id} lost pending request`)
        assert.deepEqual(await api.messages(directory, session.id), beforeMessages, `${harness.id} advanced the stored turn`)
        assert.equal(stream.frames.some((frame) => frameType(frame) === "permission.replied" && frameSessionId(frame) === session.id), false)
        await Bun.sleep(100)
        await assert.rejects(() => fs.access(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
          `${harness.id} executed the withheld tool call`)
      } finally {
        release()
      }
      assert.equal((await api.session(directory, session.id)).id, session.id)
      console.log(`H3b ${harness.id}: failed save retained permission without a live reply`)
    }
    assert.ok(stack.scripted.counts().messages > 0, "Claude did not call the scripted model")
    assert.ok(stack.scripted.counts().responses > 0, "Codex did not call the scripted model")
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "native harness attempted an unexpected external host")
    console.log(`H3b native background attempts refused by guard: ${JSON.stringify(stack.egress.attempts)}`)
  } finally {
    await stack.close()
  }
}
