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
export async function installFakeCodexAppServer(options: { command?: boolean; terminateFails?: boolean; terminalSurvives?: boolean; childCommand?: boolean; listFails?: boolean; listFailsOnSecondRead?: boolean; childCommandOnly?: boolean } = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-goal-"))
  const log = path.join(directory, "requests.jsonl")
  const goalFile = path.join(directory, "goal.json")
  const script = `
const fs = require("fs")
const log = ${JSON.stringify(log)}
const goalFile = ${JSON.stringify(goalFile)}
const command = ${JSON.stringify(options.command ?? false)}
const terminateFails = ${JSON.stringify(options.terminateFails ?? false)}
// Acknowledges the termination and keeps listing the terminal: a provider that
// accepted the request and did not carry it out.
const terminalSurvives = ${JSON.stringify(options.terminalSurvives ?? false)}
// A subagent thread this turn spawned, running a command of its own. Its
// terminal lives on that thread's inventory, not the parent's.
const childCommand = ${JSON.stringify(options.childCommand ?? false)}
const listFails = ${JSON.stringify(options.listFails ?? false)}
// Fails only on the subagent thread's confirming read, so the parent's
// terminals are found and terminated before the child stops answering.
const listFailsOnSecondRead = ${JSON.stringify(options.listFailsOnSecondRead ?? false)}
const listReads = new Map()
// The turn itself runs no command; only the subagent thread it spawns does.
const childCommandOnly = ${JSON.stringify(options.childCommandOnly ?? false)}
let buffer = ""
let goal = fs.existsSync(goalFile) ? JSON.parse(fs.readFileSync(goalFile, "utf8")) : null
let threadKnown = false
const terminated = new Set()
function write(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
function persistGoal() {
  if (goal) fs.writeFileSync(goalFile, JSON.stringify(goal))
  else if (fs.existsSync(goalFile)) fs.unlinkSync(goalFile)
}
function record(message) {
  fs.appendFileSync(log, JSON.stringify({ method: message.method, status: message.params?.status, ...(message.method.includes("backgroundTerminals") ? { processId: message.params?.processId } : {}), ...(message.params?.expectedTurnId ? { expectedTurnId: message.params.expectedTurnId } : {}) }) + "\\n")
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
      if (command) setTimeout(() => write({ id: message.id, result: { turn: { id: "turn-1" } } }), 100)
      else write({ id: message.id, result: { turn: { id: "turn-1" } } })
      write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } })
      if (command) {
        write({ method: "item/started", params: { threadId: "thread-1", turnId: "previous-turn", item: { id: "cmd-previous", type: "commandExecution", processId: "process-previous", command: "sleep 100", status: "inProgress" } } })
        write({ method: "item/started", params: { threadId: "other-thread", turnId: "other-turn", item: { id: "cmd-other", type: "commandExecution", processId: "process-other", command: "sleep 100", status: "inProgress" } } })
        if (!childCommandOnly) write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-current", type: "commandExecution", processId: "process-current", command: "sleep 100", status: "inProgress" } } })
        if (childCommand || childCommandOnly) {
          write({ method: "thread/started", params: { thread: { id: "child-thread", parentThreadId: "thread-1", status: { type: "active" } } } })
          write({ method: "item/started", params: { threadId: "child-thread", turnId: "child-turn", item: { id: "cmd-child", type: "commandExecution", processId: "process-child", command: "sleep 100", status: "inProgress" } } })
          // A parent-thread marker AFTER the child's command, so a test can
          // wait for the whole arrangement rather than racing it.
          write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "child-ready", type: "agentMessage", text: "child-command-running" } } })
        }
      }
    }
    else if (message.method === "thread/backgroundTerminals/list") {
      // Per thread, the way the app-server scopes it: a subagent thread's
      // terminals are on that thread's inventory, not on its parent's.
      if (!message.params.cursor) listReads.set(message.params.threadId, (listReads.get(message.params.threadId) ?? 0) + 1)
      const reads = listReads.get(message.params.threadId) ?? 1
      // The second-read failure targets the SUBAGENT thread's confirming read:
      // the parent's terminals are found and terminated, and then the child's
      // inventory stops answering.
      if (listFails || (listFailsOnSecondRead && message.params.threadId !== "thread-1" && reads >= 2)) {
        write({ id: message.id, error: { message: "terminal inventory is unavailable" } })
        continue
      }
      if (message.params.threadId !== "thread-1") {
        // A terminated terminal leaves the inventory.
        const owned = (childCommand || childCommandOnly) && message.params.threadId === "child-thread" && !terminated.has("process-child")
          ? [{ itemId: "cmd-child", processId: "process-child" }]
          : []
        write({ id: message.id, result: { data: owned, nextCursor: null } })
        continue
      }
      // Paging is preserved so the caller still has to read both pages of the
      // parent's inventory to learn what survived.
      const page = message.params.cursor === "second"
        ? [{ itemId: "cmd-current", processId: "process-current" }]
        : [{ itemId: "cmd-previous", processId: "process-previous" }]
      write({ id: message.id, result: {
        data: page.filter((row) => !terminated.has(row.processId)),
        nextCursor: message.params.cursor === "second" ? null : "second",
      } })
    }
    else if (message.method === "thread/backgroundTerminals/terminate") {
      setTimeout(() => {
        if (terminateFails) write({ id: message.id, error: { message: "terminal cleanup failed" } })
        else {
          if (!terminalSurvives) terminated.add(message.params.processId)
          fs.writeFileSync(goalFile + ".terminated", message.params.processId)
          write({ id: message.id, result: {} })
        }
      }, 100)
    }
    else if (message.method === "turn/interrupt") {
      write({ id: message.id, result: {} })
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: message.params.turnId, status: "interrupted" } } })
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
        if (command) {
          write({ method: "item/started", params: { threadId: "thread-1", turnId: "previous-turn", item: { id: "cmd-previous", type: "commandExecution", processId: "process-previous", command: "sleep 100", status: "inProgress" } } })
          write({ method: "item/started", params: { threadId: "thread-1", turnId: "goal-turn-1", item: { id: "cmd-current", type: "commandExecution", processId: "process-current", command: "sleep 100", status: "inProgress" } } })
        }
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
