import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ApiError, ClaxedoApi, type MessageRow } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

function childTranscriptNames(messages: MessageRow[], marker: string): boolean {
  return messages.some((message) => message.parts.some((part) => part.type === "text" && part.text?.includes(marker)))
}

const NATIVE = [
  { id: "claude", providerId: "anthropic", modelId: "claude-sonnet-4-5", mode: "default",
    spawn: (prompt: string) => ({ name: "Agent", input: { description: "Write a file", prompt, subagent_type: "general-purpose", run_in_background: false } }),
    childPrompt: (prompt: string) => prompt,
    command: (command: string) => ({ name: "Bash", input: { command, description: "Write the file" } }) },
  { id: "codex", providerId: "openai", modelId: "gpt-4.1", mode: "workspace-write",
    spawn: (prompt: string) => ({ name: "spawn_agent", namespace: "multi_agent_v1", input: { message: prompt } }),
    childPrompt: (prompt: string) => `"text":"${prompt}`,
    command: (command: string) => ({ name: "exec_command", input: { cmd: command, sandbox_permissions: "require_escalated", justification: "Write the file" } }) },
] as const

export async function run() {
  const stack = await startStack({ label: "h3-child-permissions" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h3-child-permissions")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    for (const harness of NATIVE) {
      const parentMarker = `H3C_${harness.id.toUpperCase()}_PARENT`
      const childMarker = `H3C_${harness.id.toUpperCase()}_CHILD`
      const output = path.join(stack.dataDir, `${harness.id}-child.txt`)
      const childPrompt = `Run the command, then reply with exactly this one token: ${childMarker}`
      stack.scripted.scriptTool({ ...harness.spawn(childPrompt), whenPromptIncludes: parentMarker })
      stack.scripted.scriptTool({ ...harness.command(`printf approved > '${output}'`), whenPromptIncludes: harness.childPrompt(childPrompt) })
      const parent = await api.createSession(directory, { harness: { id: harness.id, access: "native" },
        permissionMode: harness.mode, model: { providerId: harness.providerId, modelId: harness.modelId } })
      const since = stream.frames.length
      await api.promptAsync(directory, parent.id, `Delegate one child task, then reply with exactly this one token: ${parentMarker}`)
      const asked = await stream.waitFor((frame) => stream.frames.indexOf(frame) >= since && frameType(frame) === "permission.asked",
        { label: `${harness.id} child permission asked`, timeoutMs: 90_000 })
      const child = (await api.sessions(directory)).find((row) => row.parentID === parent.id)
      assert.ok(child, `${harness.id} did not create a child session`)
      assert.equal(frameSessionId(asked), child.id, `${harness.id} filed the subagent's permission on ${frameSessionId(asked)}`)
      assert.equal(stream.frames.some((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === parent.id), false,
        `${harness.id} filed a permission on the parent`)
      const row = (await api.permissions(directory)).find((item) => item.sessionID === child.id)
      assert.ok(row, `${harness.id} listed no permission on the child`)
      await assert.rejects(() => api.replyPermission(directory, parent.id, row.id, "once"),
        (error: unknown) => error instanceof ApiError && error.status === 404, `${harness.id} answered the child's request on the parent`)
      await assert.rejects(() => fs.access(output), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT")
      await api.replyPermission(directory, child.id, row.id, "once")
      await stream.waitFor((frame) => stream.frames.indexOf(frame) >= since && frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id,
        { label: `${harness.id} parent idle`, timeoutMs: 90_000 })
      if (harness.id === "codex") await waitForTitle(stream, parent.id)
      await stream.waitFor((frame) => stream.frames.indexOf(frame) >= since && frameType(frame) === "session.idle" && frameSessionId(frame) === child.id,
        { label: `${harness.id} child idle`, timeoutMs: 90_000 })
      assert.equal(await fs.readFile(output, "utf8"), "approved")
      assert.ok(childTranscriptNames(await api.messages(directory, child.id), childMarker), `${harness.id} child transcript lost its task`)
      await assert.rejects(() => api.replyPermission(directory, child.id, row.id, "once"),
        (error: unknown) => error instanceof ApiError && error.status === 404, `${harness.id} took a duplicate answer`)
      console.log(`H3 ${harness.id} child: a subagent's permission was filed, answered and refused on the parent as the child's own`)
    }
    await idleParentChild(stack, api, stream, directory)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
  } finally {
    await stack.close()
  }
}

async function idleParentChild(stack: Stack, api: ClaxedoApi, stream: EventStream, directory: string) {
  const parentMarker = "H3C_CLAUDE_BACKGROUND_PARENT"
  const childMarker = "H3C_CLAUDE_BACKGROUND_CHILD"
  const output = path.join(stack.dataDir, "claude-background-child.txt")
  stack.scripted.scriptTool({ name: "Agent", whenPromptIncludes: parentMarker, input: { description: "Write a file in the background",
    prompt: `Run the command, then reply with exactly this one token: ${childMarker}`, subagent_type: "general-purpose", run_in_background: true } })
  stack.scripted.scriptTool({ name: "Bash", whenPromptIncludes: childMarker, opening: true, input: { command: `printf approved > '${output}'`, description: "Write the file" } })
  const release = stack.scripted.holdOpeningReplies(childMarker)
  try {
    const parent = await api.createSession(directory, { harness: { id: "claude", access: "native" }, permissionMode: "default",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" } })
    const since = stream.frames.length
    await api.promptAsync(directory, parent.id, `Delegate one background task, then reply with exactly this one token: ${parentMarker}`)
    await stack.scripted.textGateReached(childMarker)
    await stream.waitFor((frame) => stream.frames.indexOf(frame) >= since && frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id,
      { label: "claude parent idle before its background agent asks", timeoutMs: 90_000 })
    const child = (await api.sessions(directory)).find((row) => row.parentID === parent.id)
    assert.ok(child, "claude did not create a background child session")
    release()
    const asked = await stream.waitFor((frame) => stream.frames.indexOf(frame) >= since && frameType(frame) === "permission.asked",
      { label: "claude background child permission asked", timeoutMs: 90_000 })
    assert.equal(frameSessionId(asked), child.id, `claude filed the idle parent's subagent permission on ${frameSessionId(asked)}`)
    const row = (await api.permissions(directory)).find((item) => item.sessionID === child.id)
    assert.ok(row, "claude listed no permission on the background child")
    await assert.rejects(() => api.replyPermission(directory, parent.id, row.id, "once"),
      (error: unknown) => error instanceof ApiError && error.status === 404, "claude answered the background child's request on the parent")
    await api.replyPermission(directory, child.id, row.id, "once")
    const childIdle = await stream.waitFor((frame) => stream.frames.indexOf(frame) >= since && frameType(frame) === "session.idle" && frameSessionId(frame) === child.id,
      { label: "claude background child idle", timeoutMs: 90_000 })
    await stream.waitFor((frame) => stream.frames.indexOf(frame) > stream.frames.indexOf(childIdle) && frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id,
      { label: "claude parent idle after reporting its background child", timeoutMs: 90_000 })
    assert.equal(await fs.readFile(output, "utf8"), "approved")
    assert.ok(childTranscriptNames(await api.messages(directory, child.id), childMarker), "claude background child transcript lost its task")
    console.log("H3 claude background child: a request asked while its parent was idle was filed and answered on the child")
  } finally { release() }
}
