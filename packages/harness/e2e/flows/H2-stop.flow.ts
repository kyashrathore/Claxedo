import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { operation, readRecovery, stopRequest, submitRecovery, waitForTurnTarget } from "../harness/recovery-http"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

type Case = { name: string; harness: { id: string; access: "native" | "connection" }; model?: { providerId: string; modelId: string }; state: "succeeded" | "needs_action"; command?: boolean; cleanup?: "owned" }

const CASES: Case[] = [
  { name: "acp", harness: SCRIPTED_ACP_HARNESS, state: "needs_action" },
  { name: "pi", harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" }, state: "needs_action" },
  { name: "claude", harness: { id: "claude", access: "native" }, model: { providerId: "claude", modelId: "sonnet" }, state: "needs_action" },
  { name: "codex", harness: { id: "codex", access: "native" }, model: { providerId: "codex", modelId: "gpt-5.5" }, state: "succeeded" },
]

export async function stopCase(stack: Stack, api: ClaxedoApi, item: Case) {
  const workspace = await stack.daemon.makeWorkspace(`h2-${item.name}`)
  const stream = await stack.events(workspace.directory)
  const session = await api.createSession(workspace.directory, { harness: item.harness, title: `H2 ${item.name}`, ...(item.model ? { model: item.model } : {}) })
  const marker = `H2STOP${item.name.toUpperCase()}`
  let release: (() => void) | undefined
  if (item.name === "acp") {
    await stack.acp.write(`h2-${item.name}`, { steps: [{ kind: "text", text: `Holding ${marker}` }, { kind: "hold", name: `h2-${item.name}` }] })
  } else {
    if (item.command) {
      stack.scripted.scriptTool({ name: "exec_command", input: { cmd: "sleep 120", yield_time_ms: 1000 }, whenPromptIncludes: marker })
      release = stack.scripted.holdTextReplies("Process running with session ID")
    }
    else release = stack.scripted.holdTextReplies(marker)
  }
  try {
    await api.promptAsync(workspace.directory, session.id, item.name === "acp" ? `${marker} ${acpScriptToken(`h2-${item.name}`)}` : marker)
    const target = await waitForTurnTarget(stack.url, workspace.directory, session.id)
    assert.equal(target.sessionId, session.id)
    if (item.name !== "acp") {
      const deadline = Date.now() + 15_000
      while (!stack.scripted.requests.some((request) => request.prompt.includes(marker)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(marker)), `${item.name} never reached the scripted model: ${stack.daemon.log()}`)
      if (item.command) {
        const deadline = Date.now() + 20_000
        while (!stack.scripted.requests.some((request) => request.prompt.includes("Process running with session ID")) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("Process running with session ID")), "Codex did not run the scripted command")
      }
    }
    const submitted = await submitRecovery(stack.url, workspace.directory, session.id, stopRequest(target))
    const stopped = operation(submitted, item.state)
    assert.equal(stopped.target.scope, "turn")
    assert.equal(stopped.facts.execution.value, "terminal")
    assert.equal(stopped.facts.persistence.value, "committed")
    assert.equal(stopped.facts.cleanup.value, item.cleanup ?? (item.state === "succeeded" ? "verified_clear" : "unknown"))
    const read = await readRecovery(stack.url, workspace.directory, session.id, stopped.operationId)
    assert.deepEqual(operation(read, item.state), stopped)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: `${item.name} stopped session.idle` })
    const stored = await api.messages(workspace.directory, session.id)
    assert.ok(stored.some((message) => message.info.role === "user" && message.parts.some((part) => part.text?.includes(marker))), `${item.name} stored user turn missing`)
    const sessionRead = await api.session(workspace.directory, session.id)
    assert.equal(sessionRead.lastTurn?.status, "cancelled", JSON.stringify({ operation: stopped, session: sessionRead, frames: stream.frames.map(frameType) }))
    if (item.name === "acp") assert.match(assistantText(stored), /Holding H2STOPACP/)

    const refused = await submitRecovery(stack.url, workspace.directory, session.id, stopRequest({ ...target, turnId: "no-such-running-turn" }))
    assert.equal(refused.status, 409)
    assert.equal(refused.body.kind, "refused")
    if (refused.body.kind === "refused") assert.equal(refused.body.refusal.kind, "generation_conflict")
    console.log(`H2 ${item.name}: ${item.state}, cleanup ${stopped.facts.cleanup.value}; refused idle Stop 409; frames, stored turn, operation readback passed`)
  } finally {
    release?.()
    await stack.acp.release(`h2-${item.name}`)
  }
}

export async function run() {
  const stack = await startStack({ label: "h2-stop" })
  try {
    const api = new ClaxedoApi(stack.url)
    for (const item of CASES) await stopCase(stack, api, item)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "H2 attempted outbound egress")
  } finally {
    await stack.close()
  }
}
