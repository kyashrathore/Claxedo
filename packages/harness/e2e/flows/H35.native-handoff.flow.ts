import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startStack({ label: "h35-native" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h35-native")
    const stream = await stack.events(workspace.directory)
    for (const target of ["claude", "codex"] as const) {
      const marker = target.toUpperCase()
      const source = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
      stack.scripted.scriptText({ marker: `H35${marker}SOURCE`, text: `H35 ${target} transcript proof` })
      await api.prompt(workspace.directory, source.id, `Say H35${marker}SOURCE`, { model: { providerId: "pi", modelId: "openai/gpt-4.1" }, title: true })
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === source.id, { label: `${target} source turn`, timeoutMs: 60_000 })
      await waitForTitle(stream, source.id)
      assert.match(assistantText(await api.messages(workspace.directory, source.id)), new RegExp(`H35 ${target} transcript proof`))
      const switched = await api.updateSessionConfig(workspace.directory, source.id, { harness: { id: target, access: "native" } })
      assert.equal((switched.handoff as { pending?: boolean })?.pending, true)
      assert.equal(switched.model, undefined)
      const frameCount = stream.frames.length
      stack.scripted.scriptText({ marker: `H35${marker}TARGET`, text: `H35${marker}TARGET` })
      await api.prompt(workspace.directory, source.id, `Continue H35${marker}TARGET`)
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === source.id && stream.frames.indexOf(frame) >= frameCount, { label: `${target} target turn`, timeoutMs: 60_000 })
      const request = stack.scripted.requests.find((row) => row.dialect === (target === "claude" ? "messages" : "responses") && row.prompt.includes(`H35${marker}TARGET`))
      assert.ok(request, `${target} target never reached the scripted model`)
      assert.match(JSON.stringify(request.body), new RegExp(`H35 ${target} transcript proof`), `${target} target did not receive the handoff transcript`)
      assert.match(assistantText(await api.messages(workspace.directory, source.id)), new RegExp(`H35${marker}TARGET`))
      assert.equal((await api.sessionConfig(workspace.directory, source.id)).handoff, undefined)
      assert.ok((await api.messages(workspace.directory, source.id)).some((message) => message.parts.some((part) => part.type === "handoff")))
      assert.equal((await api.session(workspace.directory, source.id)).id, source.id)
    }
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H35 native: Claude and Codex received Pi's stored transcript across real CLI turns")
  } finally {
    await stack.close()
  }
}
