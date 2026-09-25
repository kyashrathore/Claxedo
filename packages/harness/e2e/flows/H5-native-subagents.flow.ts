import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

const NATIVE = [
  { id: "claude", providerId: "anthropic", modelId: "claude-sonnet-4-5", tool: "Agent", mode: "bypassPermissions",
    input: { description: "Inspect child", prompt: "Reply with exactly CHILD-CLAUDE-NATIVE", subagent_type: "general-purpose", run_in_background: false } },
  { id: "codex", providerId: "openai", modelId: "gpt-4.1", tool: "spawn_agent", mode: "full-access",
    input: { task_name: "child_inspect", message: "Reply with exactly CHILD-CODEX-NATIVE" } },
] as const

export async function run() {
  const stack = await startStack({ label: "h5-native-subagents" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h5-native-subagents")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    for (const harness of NATIVE) {
      const marker = `H5_${harness.id.toUpperCase()}_PARENT`
      stack.scripted.scriptTool({ name: harness.tool, input: harness.input, whenPromptIncludes: marker })
      const parent = await api.createSession(directory, { harness: { id: harness.id, access: "native" },
        permissionMode: harness.mode, model: { providerId: harness.providerId, modelId: harness.modelId } })
      await api.promptAsync(directory, parent.id, `Delegate one child task, then reply with exactly this one token: ${marker}`)
      const deadline = Date.now() + 90_000
      let child = (await api.sessions(directory)).find((row) => row.parentID === parent.id)
      while (!child && Date.now() < deadline) {
        await Bun.sleep(100)
        child = (await api.sessions(directory)).find((row) => row.parentID === parent.id)
      }
      assert.ok(child, `${harness.id} did not create a child session`)
      assert.equal((await api.session(directory, child.id)).parentID, parent.id)
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id,
        { label: `${harness.id} parent idle`, timeoutMs: 90_000 })
      let childText = assistantText(await api.messages(directory, child.id))
      while (!childText && Date.now() < deadline) {
        await Bun.sleep(100)
        childText = assistantText(await api.messages(directory, child.id))
      }
      assert.ok(childText, `${harness.id} child transcript was empty`)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "subagent.updated" && frameSessionId(frame) === parent.id))
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === child.id))
      assert.doesNotMatch(assistantText(await api.messages(directory, parent.id)), /CHILD-(CLAUDE|CODEX)-NATIVE/)
      const usage = await api.usageBySession(Date.now() - 120_000, Date.now() + 60_000)
      assert.ok(usage.claxedo.totals.input > 0,
        `${harness.id} usage was absent from the local person's totals`)
      assert.ok(usage.breakdown.rows.some((row) => row.value.endsWith(`:session:${parent.id}`) && row.input > 0),
        `${harness.id} usage was not attributed to parent: ${JSON.stringify(usage.breakdown.rows)}`)
      console.log(`H5 ${harness.id}: child transcript, parent link, live frames and owner usage passed`)
    }
    assert.ok(stack.scripted.counts().messages > 0)
    assert.ok(stack.scripted.counts().responses > 0)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log(`H5 native background attempts refused by guard: ${JSON.stringify(stack.egress.attempts)}`)
  } finally {
    await stack.close()
  }
}
