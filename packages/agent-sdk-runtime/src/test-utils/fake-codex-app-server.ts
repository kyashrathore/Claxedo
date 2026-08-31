import fs from "fs"
import os from "os"
import path from "path"

/**
 * A scripted stand-in for the Codex app-server used by Goal tests. It speaks
 * the JSON-RPC line protocol on stdio, persists the Goal to disk so a restarted
 * process observes durable state, and logs every request for order assertions.
 *
 * Objective markers steer the scripted Goal turn:
 * - `provider-pauses`: the fake pauses the Goal mid-turn via a
 *   `thread/goal/updated` notification, then keeps streaming the remaining
 *   frames of the already-started turn.
 * - `hold-turn`: the Goal turn stays inProgress until interrupted, so callers
 *   can exercise pause/stop against an in-flight turn.
 */
export async function installFakeCodexAppServer() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-goal-"))
  const log = path.join(directory, "requests.jsonl")
  const goalFile = path.join(directory, "goal.json")
  const script = `
const fs = require("fs")
const log = ${JSON.stringify(log)}
const goalFile = ${JSON.stringify(goalFile)}
let buffer = ""
let goal = fs.existsSync(goalFile) ? JSON.parse(fs.readFileSync(goalFile, "utf8")) : null
let threadKnown = false
function write(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
function persistGoal() {
  if (goal) fs.writeFileSync(goalFile, JSON.stringify(goal))
  else if (fs.existsSync(goalFile)) fs.unlinkSync(goalFile)
}
function record(message) {
  fs.appendFileSync(log, JSON.stringify({ method: message.method, status: message.params?.status }) + "\\n")
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const boundary = buffer.indexOf("\\n")
    if (boundary < 0) return
    const line = buffer.slice(0, boundary).trim()
    buffer = buffer.slice(boundary + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (!message.id) continue
    record(message)
    if (message.method === "initialize") write({ id: message.id, result: { userAgent: "fake" } })
    else if (message.method === "thread/start") {
      threadKnown = true
      write({ id: message.id, result: { thread: { id: "thread-1" } } })
    }
    else if (message.method === "thread/resume") {
      threadKnown = true
      write({ id: message.id, result: { thread: { id: "thread-1" } } })
    }
    else if (message.method === "thread/goal/get") {
      if (!threadKnown) write({ id: message.id, error: { message: "thread not found: thread-1" } })
      else write({ id: message.id, result: { goal } })
    }
    else if (message.method === "turn/start") {
      write({ id: message.id, result: { turn: { id: "turn-1" } } })
      write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } })
    }
    else if (message.method === "turn/interrupt") {
      write({ id: message.id, result: {} })
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } })
    }
    else if (message.method === "thread/goal/set") {
      if (!threadKnown) {
        write({ id: message.id, error: { message: "thread not found: thread-1" } })
        continue
      }
      const now = Date.now()
      goal = {
        threadId: "thread-1",
        objective: message.params.objective ?? goal?.objective,
        status: message.params.status ?? "active",
        tokenBudget: 1000,
        tokensUsed: 25,
        timeUsedSeconds: 3,
        createdAt: goal?.createdAt ?? now,
        updatedAt: now,
      }
      persistGoal()
      write({ method: "thread/goal/updated", params: { threadId: "thread-1", turnId: null, goal } })
      write({ id: message.id, result: { goal } })
      if (message.params.objective) setTimeout(() => {
        const objective = message.params.objective
        write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "goal-turn-1", status: "inProgress" } } })
        write({ method: "thread/started", params: { thread: { id: "goal-child-1", parentThreadId: "thread-1", preview: "Inspect", status: { type: "active", activeFlags: [] } } } })
        write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "goal-turn-1", itemId: "goal-message-1", delta: "Working" } })
        if (objective.includes("provider-pauses")) {
          goal = { ...goal, status: "paused", updatedAt: Date.now() }
          persistGoal()
          write({ method: "thread/goal/updated", params: { threadId: "thread-1", turnId: "goal-turn-1", goal } })
          write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "goal-turn-1", itemId: "goal-message-1", delta: "After pause" } })
          write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "goal-turn-1", status: "completed" } } })
        } else if (!objective.includes("hold-turn")) {
          write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "goal-turn-1", status: "completed" } } })
        }
      }, 0)
    } else if (message.method === "thread/goal/clear") {
      if (!threadKnown) {
        write({ id: message.id, error: { message: "thread not found: thread-1" } })
        continue
      }
      const cleared = goal !== null
      goal = null
      persistGoal()
      write({ method: "thread/goal/cleared", params: { threadId: "thread-1" } })
      write({ id: message.id, result: { cleared } })
    } else write({ id: message.id, result: {} })
  }
})
`
  if (process.platform !== "win32") {
    const binary = path.join(directory, "codex")
    await fs.promises.writeFile(binary, `#!/usr/bin/env node\n${script}`, "utf8")
    await fs.promises.chmod(binary, 0o755)
    return { binary, directory, log, goalFile }
  }
  const implementation = path.join(directory, "codex-impl.cjs")
  await fs.promises.writeFile(implementation, script, "utf8")
  const binary = path.join(directory, "codex.cmd")
  await fs.promises.writeFile(binary, `@echo off\r\nnode "%~dp0codex-impl.cjs" %*\r\n`, "utf8")
  return { binary, directory, log, goalFile }
}
