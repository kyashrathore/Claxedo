import assert from "node:assert/strict"
import { ClaxedoApi, assistantText, type MessageRow } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack, type Stack } from "../harness/stack"
import { ascendingMessageIds } from "../harness/message-ids"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

const nextMessageId = ascendingMessageIds()

const CASES = [
  { name: "pi", harness: { id: "pi", access: "native" as const }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } },
  { name: "claude", harness: { id: "claude", access: "native" as const }, model: { providerId: "claude", modelId: "sonnet" } },
  { name: "codex", harness: { id: "codex", access: "native" as const }, model: { providerId: "codex", modelId: "gpt-5.5" } },
]

type QueueRow = { steering?: { state: string }; parts: Array<{ text?: string }> }

function transcriptShape(messages: MessageRow[]) {
  return messages.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    ...(message.info.role === "assistant" ? { parent: message.info.parentID, completed: (message.info.time as { completed?: number } | undefined)?.completed !== undefined } : {}),
  }))
}

function assertIncorporated(name: string, stream: EventStream, stored: MessageRow[], rows: QueueRow[], ids: { open: string; steer: string }, second: string) {
  assert.deepEqual(rows, [], `${name} steer row outlived its transcript message`)
  const shape = transcriptShape(stored)
  const steerAt = shape.findIndex((message) => message.id === ids.steer)
  assert.ok(steerAt > 1, `${name} steered prompt is not in the transcript after the opening reply: ${JSON.stringify(shape)}`)
  assert.deepEqual(shape.slice(0, steerAt + 1).map(({ role, parent }) => ({ role, parent })), [
    { role: "user", parent: undefined }, { role: "assistant", parent: ids.open }, { role: "user", parent: undefined },
  ], `${name} transcript before the steer: ${JSON.stringify(shape)}`)
  assert.ok(stored[steerAt]!.parts.some((part) => part.type === "text" && part.text === second), `${name} steered message lost its text`)
  assert.deepEqual(shape.slice(steerAt + 1).map(({ role, parent, completed }) => ({ role, parent, completed })),
    [{ role: "assistant", parent: ids.steer, completed: true }], `${name} reply after the steer: ${JSON.stringify(shape)}`)
  assert.equal(shape[steerAt - 1]!.completed, true, `${name} reply before the steer stayed open`)
  const live = stream.frames.filter((frame) => frameType(frame) === "message.updated"
    && (frame.data.payload as { properties?: { info?: { id?: string; role?: string } } }).properties?.info?.id === ids.steer)
  assert.ok(live.some((frame) => (frame.data.payload as { properties: { info: { role?: string } } }).properties.info.role === "user"),
    `${name} steered message never reached the live stream`)
}

async function steerCase(stack: Stack, api: ClaxedoApi, item: typeof CASES[number]) {
  const workspace = await stack.daemon.makeWorkspace(`h7-${item.name}`)
  const stream = await stack.events(workspace.directory)
  const session = await api.createSession(workspace.directory, { title: `H7 ${item.name}`, harness: item.harness, model: item.model })
  const first = `H7OPEN${item.name.toUpperCase()}`
  const second = `H7STEER${item.name.toUpperCase()}`
  const ids = { open: nextMessageId(), steer: nextMessageId() }
  const release = stack.scripted.holdTextReplies(first)
  try {
    await api.promptAsync(workspace.directory, session.id, first, { messageId: ids.open })
    const deadline = Date.now() + 20_000
    while (!stack.scripted.requests.some((request) => request.prompt.includes(first)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(first)), `${item.name} opening turn never reached the model`)
    const target = new URL(`/session/${encodeURIComponent(session.id)}/prompt_async`, stack.url)
    target.searchParams.set("directory", workspace.directory)
    const pending = fetch(target, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "steer", messageID: ids.steer, parts: [{ type: "text", text: second }] }),
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
    const rows = await queue.json() as QueueRow[]
    const stored = await api.messages(workspace.directory, session.id)
    assertIncorporated(item.name, stream, stored, rows, ids, second)
    assert.ok(stored.some((message) => message.info.role === "user" && message.parts.some((part) => part.text?.includes(first))))
    assert.ok(assistantText(stored).length > 0)
    assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "completed")
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(second)), `${item.name} steer never reached the model`)
    console.log(`H7 ${item.name}: steer accepted, steered prompt in the transcript where the harness took it in, model request, live idle and stored turn passed`)
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
