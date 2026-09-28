import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClaxedoApi, assistantText, type MessageRow } from "../harness/api"
import { acpScriptToken } from "../harness/acp/script"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { startStack, type Stack } from "../harness/stack"
import { frameType, type EventStream } from "../harness/stream"

type StoredToolState = {
  status?: string
  input?: { path?: unknown }
  output?: unknown
  metadata?: { acp?: { title?: unknown } }
}
type DeltaProperties = { sessionID?: string; partID?: string; field?: string; delta?: string }

function liveParts(stream: EventStream, sessionId: string) {
  const parts = new Map<string, Record<string, unknown>>()
  for (const frame of stream.frames) {
    const type = frameType(frame)
    if (type === "message.part.updated") {
      const payload = frame.data.payload as { properties?: { part?: Record<string, unknown> } } | undefined
      const part = payload?.properties?.part
      if (part?.sessionID === sessionId && typeof part.id === "string") parts.set(part.id, { ...part })
      continue
    }
    if (type !== "message.part.delta") continue
    const delta = (frame.data.payload as { properties?: DeltaProperties } | undefined)?.properties
    if (delta?.sessionID !== sessionId || !delta.partID || !delta.field || typeof delta.delta !== "string") continue
    const part = parts.get(delta.partID)
    if (!part) continue
    const previous = part[delta.field]
    part[delta.field] = `${typeof previous === "string" ? previous : ""}${delta.delta}`
  }
  return parts
}

function assertStoredPartsMatchLive(messages: MessageRow[], stream: EventStream, sessionId: string) {
  const live = liveParts(stream, sessionId)
  const assistant = messages.filter((message) => message.info.role === "assistant")
  for (const message of assistant) {
    for (const part of message.parts.filter((value) => value.type === "text" || value.type === "tool")) {
      assert.ok(part.id, `stored ${part.type} part has no id`)
      const frame = live.get(part.id)
      assert.ok(frame, `stored ${part.type} part ${part.id} has no live frame`)
      assert.equal(frame.type, part.type)
      if (part.type === "text") assert.equal(frame.text, part.text)
    }
  }
  return assistant.flatMap((message) => message.parts)
}

async function acpTurn(stack: Stack, api: ClaxedoApi) {
  const workspace = await stack.daemon.makeWorkspace("h0-acp")
  assert.ok(workspace.directory.startsWith(await fs.realpath(path.join(stack.dataDir, "workspaces"))))
  await stack.acp.write("h0-smoke", {
    steps: [
      { kind: "text", text: "Scripted hello from ACP", chunks: 2 },
      { kind: "tool", tool: "read", title: "Read smoke.txt", input: { path: "smoke.txt" }, text: "read complete" },
    ],
  })
  const stream = await stack.events(workspace.directory)
  const session = await api.createSession(workspace.directory, { title: "H0 ACP", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Run the smoke script. ${acpScriptToken("h0-smoke")}`)
  await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "ACP session.idle" })
  const messages = await api.messages(workspace.directory, session.id)
  assert.match(assistantText(messages), /Scripted hello from ACP/)
  const parts = assertStoredPartsMatchLive(messages, stream, session.id)
  const tools = parts.filter((part) => part.type === "tool")
  const read = tools.find((part) => part.tool === "read")
  assert.ok(read, `ACP read tool call was not stored; stored tool parts: ${JSON.stringify(tools)}`)
  const state = read.state as StoredToolState
  assert.equal(state.status, "completed")
  assert.equal(state.input?.path, "smoke.txt")
  assert.equal(state.output, "read complete")
  assert.equal(state.metadata?.acp?.title, "Read smoke.txt")
  assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
  console.log("H0 ACP: text and tool call match live frames and stored messages; session readback passed")
}

async function piTurn(stack: Stack, api: ClaxedoApi) {
  const workspace = await stack.daemon.makeWorkspace("h0-pi")
  const stream = await stack.events(workspace.directory)
  const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
  const session = await api.createSession(workspace.directory, { title: "H0 Pi", harness: { id: "pi", access: "native" }, model })
  await api.prompt(workspace.directory, session.id, "Reply with exactly this one token: PINNEDPISMOKE", { model })
  await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "Pi session.idle" })
  const messages = await api.messages(workspace.directory, session.id)
  assert.match(assistantText(messages), /PINNEDPISMOKE/)
  assertStoredPartsMatchLive(messages, stream, session.id)
  assert.ok(stack.scripted.requests.some((request) => request.model === "gpt-4.1" && request.prompt.includes("PINNEDPISMOKE")), "Pi did not call the scripted model")
  assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
  console.log("H0 Pi: pinned Pi answered through the scripted model; frames, messages, and session readback passed")
}

export async function run() {
  const stack = await startStack({ label: "h0-smoke" })
  const failures: Error[] = []
  try {
    assert.ok((await fs.realpath(stack.dataDir)).startsWith(await fs.realpath(os.tmpdir())), "stack did not get its own temporary data directory")
    const api = new ClaxedoApi(stack.url)
    for (const turn of [acpTurn, piTurn]) {
      try {
        await turn(stack, api)
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    assert.deepEqual(stack.egress.attempts, [], "egress guard recorded an outbound request")
    assert.ok((await api.health()).ok !== false, "daemon health readback failed")
    console.log(`H0 isolation: zero outbound attempts; private data directory ${stack.dataDir}`)
    if (failures.length) throw new AggregateError(failures, "H0 scripted turns failed")
  } finally {
    await stack.close()
  }
}
