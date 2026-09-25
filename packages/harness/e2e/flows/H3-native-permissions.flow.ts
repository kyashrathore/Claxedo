import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ApiError, ClaxedoApi, type PermissionRow } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

const NATIVE = [
  { id: "claude", providerId: "anthropic", modelId: "claude-sonnet-4-5", tool: "Bash", mode: "default" },
  { id: "codex", providerId: "openai", modelId: "gpt-4.1", tool: "exec_command", mode: "workspace-write" },
] as const

async function pending(api: ClaxedoApi, directory: string, sessionId: string, excludes: string[] = []): Promise<PermissionRow> {
  const deadline = Date.now() + 60_000
  do {
    const row = (await api.permissions(directory)).find((item) => item.sessionID === sessionId && !excludes.includes(item.id))
    if (row) return row
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  throw new Error(`No new permission for ${sessionId}`)
}

async function refused(call: () => Promise<unknown>, status: number) {
  await assert.rejects(call, (error: unknown) => error instanceof ApiError && error.status === status)
}

function scriptCommand(stack: Stack, harness: (typeof NATIVE)[number], marker: string, file: string) {
  const command = `printf approved > '${file}'`
  stack.scripted.scriptTool({ name: harness.tool, whenPromptIncludes: marker,
    input: harness.id === "claude"
      ? { command, description: `Write ${path.basename(file)}` }
      : { cmd: command, sandbox_permissions: "require_escalated", justification: `Write ${path.basename(file)}` },
  })
}

async function idle(stream: EventStream, sessionId: string, label: string, since: number) {
  await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId
    && stream.frames.indexOf(frame) >= since,
    { label, timeoutMs: 60_000 })
}

export async function run() {
  const stack = await startStack({ label: "h3-native-permissions" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h3-native-permissions")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    for (const harness of NATIVE) {
      const marker = `H3_${harness.id.toUpperCase()}_ONCE`
      const output = path.join(stack.dataDir, `${harness.id}-once.txt`)
      scriptCommand(stack, harness, marker, output)
      const session = await api.createSession(directory, { harness: { id: harness.id, access: "native" },
        permissionMode: harness.mode, model: { providerId: harness.providerId, modelId: harness.modelId } })
      await api.promptAsync(directory, session.id, `Run the command, then reply with exactly this one token: ${marker}`)
      const once = await pending(api, directory, session.id)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === session.id))
      const otherMarker = `H3_${harness.id.toUpperCase()}_FOREIGN`
      const foreignOutput = path.join(stack.dataDir, `${harness.id}-foreign.txt`)
      scriptCommand(stack, harness, otherMarker, foreignOutput)
      const other = await api.createSession(directory, { harness: { id: harness.id, access: "native" },
        permissionMode: harness.mode, model: { providerId: harness.providerId, modelId: harness.modelId } })
      await api.promptAsync(directory, other.id, `Run the command, then reply with exactly this one token: ${otherMarker}`)
      const foreign = await pending(api, directory, other.id)
      const repliesBefore = stream.frames.filter((frame) => frameType(frame) === "permission.replied").length
      await refused(() => api.replyPermission(directory, session.id, foreign.id, "once"), 409)
      assert.equal(stream.frames.filter((frame) => frameType(frame) === "permission.replied").length, repliesBefore)
      await assert.rejects(() => fs.access(foreignOutput), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        `${harness.id} executed a foreign request`)
      await api.replyPermission(directory, other.id, foreign.id, "reject")
      const onceSince = stream.frames.length
      await api.replyPermission(directory, session.id, once.id, "once")
      await idle(stream, session.id, `${harness.id} once idle`, onceSince)
      assert.equal(await fs.readFile(output, "utf8"), "approved")
      const replied = stream.frames.filter((frame) => frameType(frame) === "permission.replied" && frameSessionId(frame) === session.id).length
      await refused(() => api.replyPermission(directory, session.id, once.id, "once"), 404)
      assert.equal(stream.frames.filter((frame) => frameType(frame) === "permission.replied" && frameSessionId(frame) === session.id).length, replied)

      const alwaysMarker = `H3_${harness.id.toUpperCase()}_ALWAYS`
      const same = path.join(stack.dataDir, `${harness.id}-same.txt`)
      const different = path.join(stack.dataDir, `${harness.id}-different.txt`)
      scriptCommand(stack, harness, alwaysMarker, same)
      scriptCommand(stack, harness, alwaysMarker, same)
      scriptCommand(stack, harness, alwaysMarker, different)
      const alwaysSince = stream.frames.length
      await api.promptAsync(directory, session.id, `Run the commands, then reply with exactly this one token: ${alwaysMarker}`)
      const always = await pending(api, directory, session.id)
      await api.replyPermission(directory, session.id, always.id, "always")
      const next = await pending(api, directory, session.id, [always.id])
      assert.equal((await api.permissions(directory)).filter((row) => row.sessionID === session.id).length, 1,
        `${harness.id} prompted for an identical second call`)
      await api.replyPermission(directory, session.id, next.id, "once")
      await idle(stream, session.id, `${harness.id} always idle`, alwaysSince)
      assert.equal(await fs.readFile(same, "utf8"), "approved")
      assert.equal(await fs.readFile(different, "utf8"), "approved")

      const denyMarker = `H3_${harness.id.toUpperCase()}_DENY`
      const deniedFile = path.join(stack.dataDir, `${harness.id}-denied.txt`)
      scriptCommand(stack, harness, denyMarker, deniedFile)
      const denySince = stream.frames.length
      await api.promptAsync(directory, session.id, `Run the command, then reply with exactly this one token: ${denyMarker}`)
      const deny = await pending(api, directory, session.id)
      await api.replyPermission(directory, session.id, deny.id, "reject")
      await idle(stream, session.id, `${harness.id} deny idle`, denySince)
      await assert.rejects(() => fs.access(deniedFile), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT")
      await refused(() => api.replyPermission(directory, session.id, deny.id, "reject"), 404)
      assert.equal((await api.permissions(directory)).some((row) => row.sessionID === session.id), false)
      const tools = (await api.messages(directory, session.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool")
      assert.ok(tools.some((part) => (part.state as { status?: string } | undefined)?.status === "completed"))
      assert.ok(tools.some((part) => (part.state as { status?: string } | undefined)?.status === "error"))
      assert.equal((await api.session(directory, session.id)).id, session.id)
      console.log(`H3 ${harness.id}: once, always, deny, and foreign/duplicate/stale refusals passed`)
    }
    assert.ok(stack.scripted.counts().messages > 0)
    assert.ok(stack.scripted.counts().responses > 0)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log(`H3 native background attempts refused by guard: ${JSON.stringify(stack.egress.attempts)}`)
  } finally {
    await stack.close()
  }
}
