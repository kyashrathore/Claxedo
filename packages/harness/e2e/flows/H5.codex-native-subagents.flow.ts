import assert from "node:assert/strict"
import { eventually } from "../harness/eventually"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

const PROTOCOLS = [
  { id: "v2", modelId: "gpt-6-astra", namespace: "collaboration", childOnly: "Message Type: NEW_TASK" },
  { id: "v1", modelId: "gpt-4.1", namespace: "multi_agent_v1", childOnly: "\"text\":\"Delegated child task H5CODEXNATIVECHILD" },
] as const

type SubagentFrame = { properties?: { update?: { childSessionId?: string; status?: string; toolCallId?: string; toolCallRole?: string; mode?: string } } }

export async function run() {
  const stack = await startStack({ label: "h5-codex-native-subagents" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h5-codex-native-subagents")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    for (const protocol of PROTOCOLS) {
      const marker = `H5CODEXNATIVE${protocol.id.toUpperCase()}PARENT`
      stack.scripted.scriptTool({ name: "spawn_agent", namespace: protocol.namespace, whenPromptIncludes: marker,
        input: { task_name: "child_probe", message: "Delegated child task H5CODEXNATIVECHILD" } })
      stack.scripted.scriptText({ marker: protocol.childOnly, text: "H5CODEXNATIVECHILD-DONE" })
      const release = stack.scripted.holdTextReplies(protocol.childOnly)
      const parent = await api.createSession(directory, { harness: { id: "codex", access: "native" }, permissionMode: "full-access",
        model: { providerId: "openai", modelId: protocol.modelId } })
      await api.promptAsync(directory, parent.id, `Delegate one child task, then reply with exactly this one token: ${marker}`)
      await stack.scripted.textGateReached(protocol.childOnly)
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id,
        { label: `codex ${protocol.id} parent idle while its child runs`, timeoutMs: 90_000 })
      const child = (await api.sessions(directory)).find((row) => row.parentID === parent.id)
      assert.ok(child, `codex ${protocol.id} native subagent made no child session`)
      assert.doesNotMatch(assistantText(await api.messages(directory, child.id)), /H5CODEXNATIVECHILD-DONE/)
      release()
      await stream.waitFor((frame) => frameType(frame) === "subagent.updated" && frameSessionId(frame) === parent.id
        && (frame.data.payload as SubagentFrame).properties?.update?.status === "completed",
      { label: `codex ${protocol.id} child completed`, timeoutMs: 90_000 })
      const updates = stream.frames.filter((frame) => frameType(frame) === "subagent.updated" && frameSessionId(frame) === parent.id)
        .map((frame) => (frame.data.payload as SubagentFrame).properties?.update)
      assert.ok(updates.some((update) => update?.childSessionId === child.id && update.toolCallRole === "spawn" && update.toolCallId?.startsWith("call_") && update.mode === "background"),
        `codex ${protocol.id} spawn row was not bound to its call: ${JSON.stringify(updates)}`)
      assert.match(assistantText(await api.messages(directory, child.id)), /H5CODEXNATIVECHILD-DONE/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === child.id),
        `codex ${protocol.id} child transcript was absent from the live stream`)
      assert.doesNotMatch(assistantText(await api.messages(directory, parent.id)), /H5CODEXNATIVECHILD-DONE/)
      await eventually(`codex ${protocol.id} child usage metered on the child`, async () => {
        const usage = await api.usageBySession(Date.now() - 300_000, Date.now() + 60_000)
        return usage.breakdown.rows.some((row) => row.value.endsWith(`:session:${child.id}`) && row.input > 0) ? usage : undefined
      }, 20_000)
      console.log(`H5 codex ${protocol.id}: native child session, background transcript after the parent idled, completion and child usage passed`)
    }
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
  } finally {
    await stack.close()
  }
}
