import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

const CASES = [
  { name: "pi", harness: { id: "pi", access: "native" as const }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } },
  { name: "claude", harness: { id: "claude", access: "native" as const }, model: { providerId: "claude", modelId: "sonnet" } },
  { name: "codex", harness: { id: "codex", access: "native" as const }, model: { providerId: "codex", modelId: "gpt-5.5" } },
]

async function steerCase(stack: Stack, api: ClaxedoApi, item: typeof CASES[number]) {
  const workspace = await stack.daemon.makeWorkspace(`h7-${item.name}`)
  const stream = await stack.events(workspace.directory)
  const session = await api.createSession(workspace.directory, { title: `H7 ${item.name}`, harness: item.harness, model: item.model })
  const first = `H7OPEN${item.name.toUpperCase()}`
  const second = `H7STEER${item.name.toUpperCase()}`
  const release = stack.scripted.holdTextReplies(first)
  try {
    await api.promptAsync(workspace.directory, session.id, first)
    const deadline = Date.now() + 20_000
    while (!stack.scripted.requests.some((request) => request.prompt.includes(first)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(first)), `${item.name} opening turn never reached the model`)
    const target = new URL(`/session/${encodeURIComponent(session.id)}/prompt_async`, stack.url)
    target.searchParams.set("directory", workspace.directory)
    const pending = fetch(target, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "steer", parts: [{ type: "text", text: second }] }),
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    release()
    const steered = await pending
    const steerBody = await steered.json()
    assert.equal(steered.status, 200, `${item.name} steer HTTP: ${JSON.stringify(steerBody)}`)
    assert.deepEqual(steerBody, { delivery: "steer" })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: `${item.name} steered turn idle` })
    const queue = await fetch(new URL(`/session/${encodeURIComponent(session.id)}/queue?directory=${encodeURIComponent(workspace.directory)}`, stack.url))
    assert.equal(queue.status, 200)
    const rows = await queue.json() as Array<{ steering?: { state: string }; parts: Array<{ text?: string }> }>
    assert.ok(rows.some((row) => row.steering?.state === "accepted" && row.parts.some((part) => part.text === second)), `${item.name} steer receipt missing: ${JSON.stringify(rows)}`)
    const stored = await api.messages(workspace.directory, session.id)
    assert.ok(stored.some((message) => message.info.role === "user" && message.parts.some((part) => part.text?.includes(first))))
    assert.ok(assistantText(stored).length > 0)
    assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "completed")
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(second)), `${item.name} steer never reached the model`)
    console.log(`H7 ${item.name}: steer accepted, durable receipt, model request, live idle and stored turn passed`)
  } finally {
    release()
  }
}

export async function run() {
  const stack = await startStack({ label: "h7-steer" })
  try {
    const api = new ClaxedoApi(stack.url)
    for (const item of CASES) await steerCase(stack, api, item)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "H7 attempted outbound egress")
  } finally {
    await stack.close()
  }
}
