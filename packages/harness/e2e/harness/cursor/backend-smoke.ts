import assert from "node:assert/strict"
import { startEgressGuard, egressProxyEnv } from "../egress-guard"
import { startScriptedCursorBackend } from "./backend"

const backend = await startScriptedCursorBackend(48503)
const guard = await startEgressGuard(48504)
Object.assign(process.env, egressProxyEnv(guard.url))
process.env.CURSOR_BACKEND_URL = backend.url
backend.script("smoke", { steps: [
  { kind: "read", path: "smoke.txt", result: "scripted file contents" },
  { kind: "text", text: "CURSOR-SCRIPTED-ANSWER" },
], usage: { inputTokens: 2, outputTokens: 3 } })
try {
  const { Agent } = await import("@cursor/sdk")
  const agent = await Agent.create({ apiKey: "cursor-placeholder", model: { id: "scripted" }, local: { cwd: process.cwd() } })
  try {
    const run = await agent.send("CURSOR_SCRIPT:smoke")
    const messages = []
    for await (const message of run.stream()) messages.push(message)
    const result = await run.wait()
    assert.equal(result.status, "finished")
    assert.equal(result.result, "CURSOR-SCRIPTED-ANSWER")
    assert.equal(result.usage?.totalTokens, 5)
    assert.ok(messages.some((message) => message.type === "assistant"))
    assert.ok(messages.some((message) => message.type === "tool_call" && message.status === "completed"))
    assert.deepEqual(guard.attempts, [])
    console.log(JSON.stringify({ result, paths: backend.requests.map((request) => request.path), egress: guard.attempts }))
  } finally {
    agent.close()
  }
} finally {
  await backend.close()
  await guard.close()
}
