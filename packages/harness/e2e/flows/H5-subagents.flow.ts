import assert from "node:assert/strict"
import { eventually } from "../harness/eventually"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h5-subagents" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h5-subagents")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    await stack.acp.write("h5-child", {
      steps: [
        { kind: "subagent", name: "Reviewer", task: "Inspect implementation", steps: [{ kind: "text", text: "Child review complete" }] },
        { kind: "text", text: "Parent completed" },
      ],
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    })
    const parent = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H5 owner" })
    await api.promptAsync(directory, parent.id, acpScriptToken("h5-child"))
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id,
      { label: "subagent turn idle" })
    const child = (await api.sessions(directory)).find((row) => row.parentID === parent.id)
    assert.ok(child, "subagent did not create a child session")
    assert.equal((await api.session(directory, child.id)).parentID, parent.id)
    assert.match(assistantText(await api.messages(directory, child.id)), /Child review complete/)
    assert.match(assistantText(await api.messages(directory, parent.id)), /Parent completed/)
    assert.doesNotMatch(assistantText(await api.messages(directory, parent.id)), /Child review complete/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "subagent.updated" && frameSessionId(frame) === parent.id),
      "child creation was absent from the live stream")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === child.id),
      "child transcript was absent from the live stream")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "session.usage" && frameSessionId(frame) === parent.id),
      "owner usage was absent from the live stream")
    const usage = await eventually("subagent turn usage in the local person's totals", async () => {
      const read = await api.usageBySession(Date.now() - 60_000, Date.now() + 60_000)
      return read.claxedo.totals.input >= 11 && read.claxedo.totals.output >= 7 ? read : undefined
    }, 20_000)
    assert.ok(usage.breakdown.rows.some((row) => row.value.endsWith(`:session:${parent.id}`) && row.input >= 11 && row.output >= 7),
      `subagent turn usage was not attributed to the owning session: ${JSON.stringify(usage.breakdown.rows)}`)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H5 ACP: child session, parent link, isolated stored messages, live creation and owner usage passed")
  } finally {
    await stack.close()
  }
}
