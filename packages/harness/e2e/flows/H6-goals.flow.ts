import assert from "node:assert/strict"
import { ClaxedoApi, assistantText, type GoalSnapshot } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { startStack } from "../harness/stack"
import { frameType, type EventStream } from "../harness/stream"

function liveGoal(stream: EventStream, sessionId: string, status: string) {
  return stream.frames.find((frame) => {
    if (frameType(frame) !== "goal.updated") return false
    const properties = (frame.data.payload as { properties?: { sessionID?: string; goal?: GoalSnapshot } }).properties
    return properties?.sessionID === sessionId && properties.goal?.status === status
  })
}

async function assertGoal(api: ClaxedoApi, stream: EventStream, directory: string, sessionId: string, status: string) {
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
    await assertGoal(api, stream, workspace.directory, session.id, "stopped")
    assert.deepEqual(stack.egress.attempts, [], "ACP goal flow made an outbound request")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    console.log("H6 ACP: negotiated Goal extension, pause/resume/stop route snapshots, live frames, stored turn, and session readback passed")
  } finally {
    await stack.close()
  }
}

async function piEvaluatedGoal() {
  const stack = await startStack({ label: "h6-pi-goals" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h6-pi-goals")
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: "pi", access: "native" }, model, title: "H6 Pi evaluated goal",
    })
    const state = await api.goalState(workspace.directory, session.id)
    assert.equal(state.capabilities.implemented, true)
    assert.equal(state.capabilities.available, true)
    const objective = "Produce the scripted goal evidence"
    const started = await api.startGoal(workspace.directory, session.id, objective)
    assert.equal(started.goal?.status, "active")
    await stream.waitFor((frame) => {
      if (frameType(frame) !== "goal.updated") return false
      const properties = (frame.data.payload as { properties?: { sessionID?: string; goal?: GoalSnapshot } }).properties
      return properties?.sessionID === session.id && properties.goal?.status === "complete"
    }, { label: "Pi evaluated Goal complete", timeoutMs: 60_000 })
    const completed = await assertGoal(api, stream, workspace.directory, session.id, "complete")
    assert.equal(completed?.objective, objective)
    assert.ok(Number(completed?.iteration) >= 2, "Pi must run both evaluator iterations")
    const messages = await api.messages(workspace.directory, session.id)
    assert.ok(messages.some((message) => message.info.role === "assistant"), "Pi Goal iterations must be stored")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "Pi Goal iterations must stream")
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(objective)), "Pi Goal must reach the scripted model")
    assert.deepEqual(stack.egress.attempts, [], "Pi Goal flow made an outbound request")
    console.log("H6 Pi: two evaluated iterations, complete Goal route and frame, stored messages, and scripted model request passed")
  } finally {
    await stack.close()
  }
}

export async function run() {
  await acpGoal()
  await piEvaluatedGoal()
}
