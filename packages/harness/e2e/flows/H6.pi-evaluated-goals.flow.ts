import assert from "node:assert/strict"
import { ClaxedoApi, type GoalSnapshot } from "../harness/api"
import { startStack } from "../harness/stack"
import { frameType } from "../harness/stream"
import { assertGoal } from "./H6-goals.flow"

export async function run() {
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
    assert.ok(state.capabilities.implemented && state.capabilities.available,
      `H-37: Pi declares no evaluated Goal: ${JSON.stringify(state.capabilities)}`)
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
