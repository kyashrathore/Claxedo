import assert from "node:assert/strict"
import { ClaxedoApi, assistantText, type GoalSnapshot } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameType, type EventStream } from "../harness/stream"

function liveGoal(stream: EventStream, sessionId: string, status: string) {
  return stream.frames.find((frame) => {
    if (frameType(frame) !== "goal.updated") return false
    const properties = (frame.data.payload as { properties?: { sessionID?: string; goal?: GoalSnapshot } }).properties
    return properties?.sessionID === sessionId && properties.goal?.status === status
  })
}

export async function assertGoal(api: ClaxedoApi, stream: EventStream, directory: string, sessionId: string, status: string) {
  const route = await api.goal(directory, sessionId)
  const combined = await api.goalState(directory, sessionId)
  assert.equal(route?.status, status, `Goal route must report ${status}`)
  assert.deepEqual(combined.goal, route, "combined Goal state must match the Goal route")
  assert.ok(liveGoal(stream, sessionId, status), `live Goal frame must report ${status}`)
  return route
}

async function acpGoal() {
  const stack = await startStack({ label: "h6-acp-goals" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h6-acp-goals")
    await stack.acp.write("h6-ready", { steps: [{ kind: "text", text: "Goal session ready" }] })
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS, title: "H6 ACP goals" })
    await api.prompt(workspace.directory, session.id, `Initialize goal session ${acpScriptToken("h6-ready")}`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "ACP goal session idle" })
    const messages = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(messages), /Goal session ready/, "stored ACP turn must exist")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "ACP turn must have live message frames")
    const capabilities = (await api.goalState(workspace.directory, session.id)).capabilities
    assert.equal(capabilities.implemented, true)
    assert.equal(capabilities.available, true)
    assert.ok(capabilities.actions.includes("pause") && capabilities.actions.includes("resume"))
    if (process.env.CLAXEDO_E2E_REFUSE_GOAL_START === "1") stack.acp.refuseGoalStart()
    const objective = "Verify ACP goal pause and resume"
    const started = await api.startGoal(workspace.directory, session.id, objective).catch((error: unknown) => {
      assert.fail(`Goal start must cross the ACP extension: ${String(error)}`)
    })
    assert.equal(started.goal?.objective, objective)
    await assertGoal(api, stream, workspace.directory, session.id, "active")
    await api.goalAction(workspace.directory, session.id, "pause")
    await assertGoal(api, stream, workspace.directory, session.id, "paused")
    await api.goalAction(workspace.directory, session.id, "resume")
    await assertGoal(api, stream, workspace.directory, session.id, "active")
    await api.goalAction(workspace.directory, session.id, "stop")
    await assertGoal(api, stream, workspace.directory, session.id, "complete")
    assert.deepEqual(stack.egress.attempts, [], "ACP goal flow made an outbound request")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    console.log("H6 ACP: negotiated Goal extension, pause/resume/stop route snapshots, live frames, stored turn, and session readback passed")
  } finally {
    await stack.close()
  }
}

async function nativeGoal(harnessId: "claude" | "codex") {
  const stack = await startStack({ label: `h6-${harnessId}-goals` })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace(`h6-${harnessId}-goals`)
    const stream = await stack.events(workspace.directory)
    const model = harnessId === "claude"
      ? { providerId: "claude", modelId: "claude-sonnet-4-6" }
      : { providerId: "codex", modelId: "gpt-5.5" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: harnessId, access: "native" }, model, title: `H6 ${harnessId} Goal`,
    })
    await api.prompt(workspace.directory, session.id, `Initialize ${harnessId} Goal session H6INITIAL`, { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: `${harnessId} initial turn idle`, timeoutMs: 60_000 })
    assert.ok((await api.messages(workspace.directory, session.id)).some((message) => message.info.role === "assistant"))
    const state = await api.goalState(workspace.directory, session.id)
    assert.equal(state.capabilities.available, true)
    const objective = `Complete scripted ${harnessId} H6 objective`
    const priorMessages = await api.messages(workspace.directory, session.id)
    const priorFrameCount = stream.frames.length
    const started = await api.startGoal(workspace.directory, session.id, objective)
    assert.equal(started.goal?.objective, objective)
    await stream.waitFor((frame) => frameType(frame) === "goal.updated", { label: `${harnessId} Goal frame`, timeoutMs: 60_000 })
    assert.ok(await api.goal(workspace.directory, session.id))
    if (harnessId === "codex") {
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && stream.frames.indexOf(frame) >= priorFrameCount, { label: "Codex provider Goal turn idle", timeoutMs: 60_000 })
      assert.ok((await api.messages(workspace.directory, session.id)).length > priorMessages.length, "Codex Goal must create a stored provider-started turn")
      assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(objective)), "Codex provider-started turn must call the scripted model")
      await api.goalAction(workspace.directory, session.id, "pause")
      await assertGoal(api, stream, workspace.directory, session.id, "paused")
      await api.goalAction(workspace.directory, session.id, "resume")
      await assertGoal(api, stream, workspace.directory, session.id, "active")
    } else {
      await api.goalAction(workspace.directory, session.id, "stop")
      await assertGoal(api, stream, workspace.directory, session.id, "paused")
    }
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.ok(stack.scripted.requests.length > 0, `${harnessId} must reach the scripted model`)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], `${harnessId} must not attempt unexpected outbound traffic`)
    console.log(`H6 ${harnessId}: Goal started, live frame, stored turn, route readback, and local model request passed`)
  } finally {
    await stack.close()
  }
}

async function claudeEvaluatedGoal() {
  const stack = await startStack({ label: "h6-claude-evaluated" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h6-claude-evaluated")
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "claude", modelId: "claude-sonnet-4-6" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: "claude", access: "native" }, model, title: "H6 Claude evaluated Goal",
    })
    const objective = "Produce the scripted Claude goal evidence"
    const started = await api.startGoal(workspace.directory, session.id, objective)
    assert.equal(started.goal?.objective, objective)
    await stream.waitFor((frame) => frameType(frame) === "goal.cleared"
      && (frame.data.payload as { properties?: { sessionID?: string } }).properties?.sessionID === session.id,
    { label: "Claude evaluator clearing the completed Goal", timeoutMs: 60_000 })
    assert.equal(await api.goal(workspace.directory, session.id), null, "Claude clears its native Goal after the evaluator accepts it")
    assert.equal((await api.goalState(workspace.directory, session.id)).goal, null)
    assert.ok((await api.messages(workspace.directory, session.id)).some((message) => message.info.role === "assistant"))
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"))
    assert.ok(stack.scripted.requests.filter((request) => request.prompt.includes("stopping condition been satisfied")).length >= 2, "Claude must run both evaluator checks")
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H6 Claude: two evaluator checks cleared its Goal on the route and live frame; stored messages passed")
  } finally {
    await stack.close()
  }
}

export async function run() {
  await acpGoal()
  await nativeGoal("claude")
  await claudeEvaluatedGoal()
  await nativeGoal("codex")
}
