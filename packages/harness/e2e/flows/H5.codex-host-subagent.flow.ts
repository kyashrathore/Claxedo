import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

type SubagentFrame = { properties?: { update?: { childSessionId?: string; status?: string; toolCallId?: string; toolCallRole?: string } } }

export async function run() {
  const stack = await startStack({ label: "h5-codex-host-subagent" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h5-codex-host-subagent")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    const model = { providerId: "codex", modelId: "gpt-5.5" }
    const parent = await api.createSession(directory, { harness: { id: "codex", access: "native" }, permissionMode: "full-access", model })
    stack.scripted.scriptTool({ name: "tool_search", format: "tool_search", input: { query: "create_subagent" }, whenPromptIncludes: "H5CODEXHOSTFIND" })
    await api.prompt(directory, parent.id, "Find the subagent tool H5CODEXHOSTFIND", { model })
    const found = stack.scripted.requests.filter((request) => request.prompt.includes("H5CODEXHOSTFIND")).flatMap((request) => request.tools)
    assert.deepEqual(found.filter((tool) => tool.call.name === "spawn_agent"), [], `gpt-5.5 was offered a spawn_agent tool: ${JSON.stringify(found.map((tool) => tool.name))}`)
    const create = found.find((tool) => tool.call.name === "create_subagent" && tool.call.namespace?.startsWith("mcp__claxedo"))
    assert.ok(create, `gpt-5.5 found no create_subagent tool: ${JSON.stringify(found.map((tool) => tool.name))}`)
    const childMarker = "\"text\":\"Reply with exactly this one token: H5CODEXHOSTCHILD"
    stack.scripted.scriptTool({ ...create.call, whenPromptIncludes: "H5CODEXHOSTSPAWN",
      input: { harness: "codex", prompt: "Reply with exactly this one token: H5CODEXHOSTCHILD", model: { providerID: "codex", id: "gpt-5.5" }, mode: "async" } })
    stack.scripted.scriptText({ marker: childMarker, text: "H5CODEXHOSTCHILD-DONE" })
    await api.prompt(directory, parent.id, "Start a Codex subagent H5CODEXHOSTSPAWN", { model })
    const bound = await stream.waitFor((frame) => frameType(frame) === "subagent.updated" && frameSessionId(frame) === parent.id
      && (frame.data.payload as SubagentFrame).properties?.update?.toolCallRole === "spawn", { label: "codex host child bound to its call", timeoutMs: 90_000 })
    const update = (bound.data.payload as SubagentFrame).properties!.update!
    const call = (await api.messages(directory, parent.id)).flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && JSON.stringify(part).includes("create_subagent"))
    assert.equal(update.toolCallId, (call as { callID?: string } | undefined)?.callID, `the host child was bound to another call: ${JSON.stringify(update)}`)
    const childSession = await api.session(directory, update.childSessionId!)
    assert.equal(childSession.parentID, parent.id)
    const childIdle = await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === childSession.id, { label: "codex host child idle", timeoutMs: 90_000 })
    assert.match(assistantText(await api.messages(directory, childSession.id)), /H5CODEXHOSTCHILD-DONE/)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === parent.id
      && stream.frames.indexOf(frame) > stream.frames.indexOf(childIdle), { label: "codex host parent idle after its child's result", timeoutMs: 90_000 })
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H5 codex host subagent: gpt-5.5 got no spawn_agent, found create_subagent, and started a bound Codex child that answered")
  } finally {
    await stack.close()
  }
}
