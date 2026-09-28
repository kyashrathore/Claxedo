import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { waitForAcpHold } from "../harness/acp/hold"
import { acpScriptToken } from "../harness/acp/script"
import { eventually } from "../harness/eventually"
import { readProcessRow, type ProcessRow } from "../harness/process-alive"
import { operation, stopRequest, submitRecovery, waitForTurnTarget } from "../harness/recovery-http"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

async function agentPid(scriptDir: string) {
  return eventually("scripted ACP agent pid", async () => {
    try {
      const pid = Number(await fs.readFile(path.join(scriptDir, "agent.pid"), "utf8"))
      return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  })
}

async function childRow(scriptDir: string, parent: ProcessRow) {
  const pid = await eventually("scripted ACP child pid", async () => {
    try {
      const value = Number(await fs.readFile(path.join(scriptDir, "writer.pid"), "utf8"))
      return Number.isSafeInteger(value) && value > 1 ? value : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  })
  const row = readProcessRow(pid)
  assert.ok(row, `ACP child ${pid} was absent from the OS process table`)
  assert.equal(row.parentPid, parent.pid, `ACP child ${pid} was not parented by agent ${parent.pid}`)
  return row
}

async function absent(row: ProcessRow, label: string) {
  await eventually(`${label} retired from OS process table`, async () => {
    const current = readProcessRow(row.pid)
    return !current || current.started !== row.started ? true : undefined
  }, 20_000)
  console.log(`H23 process table after retirement: ${label} pid=${row.pid} absent`)
}

async function cancelAndRetire() {
  const retirementFault = process.env.CLAXEDO_E2E_H23_RED === "1"
  const stack = await startStack({ label: "h23-cancel-retire", resistantChild: true, retirementFault })
  let agent: ProcessRow | undefined
  let child: ProcessRow | undefined
  try {
    const api = new ClaxedoApi(stack.url)
    const directory = (await stack.daemon.makeWorkspace("h23-acp")).directory
    const stream = await stack.events(directory)
    await stack.acp.write("h23-held", { steps: [
      { kind: "text", text: "H23 turn began" },
      { kind: "hold", name: "h23-held" },
    ] })
    const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H23 process ownership" })
    await api.promptAsync(directory, session.id, `H23 cancel ${acpScriptToken("h23-held")}`)
    await waitForAcpHold(stack.acp.scriptDir, "h23-held")
    agent = readProcessRow(await agentPid(stack.acp.scriptDir))
    assert.ok(agent, "ACP agent was absent from the OS process table")
    child = await childRow(stack.acp.scriptDir, agent)
    console.log(`H23 process table before retirement: agent=${JSON.stringify(agent)} child=${JSON.stringify(child)}`)
    const target = await waitForTurnTarget(stack.url, directory, session.id)
    const stopped = operation(await submitRecovery(stack.url, directory, session.id, stopRequest(target)), "needs_action")
    assert.equal(stopped.facts.execution.value, "terminal")
    assert.equal(stopped.facts.persistence.value, "committed")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
      { label: "H23 stopped session idle" })
    const status = (await api.session(directory, session.id)).lastTurn?.status
    assert.match(assistantText(await api.messages(directory, session.id)), /H23 turn began/)

    const archivedAt = Date.now()
    assert.equal((await api.updateSession(directory, session.id, { time: { archived: archivedAt } })).time.archived, archivedAt)
    assert.ok((await api.archivedSessions(directory)).some((row) => row.id === session.id))
    await api.deleteSession(directory, session.id)
    console.log(`H23 process table after deletion: agent=${JSON.stringify(readProcessRow(agent.pid))} child=${JSON.stringify(readProcessRow(child.pid))}`)
    if (retirementFault) {
      const record = await eventually("descendant retirement fault reached", async () => {
        const value = await fs.readFile(path.join(stack.dataDir, "retirement-fault.log"), "utf8")
        return process.platform === "win32" ? value.includes("taskkill") ? value : undefined
          : value.includes("kill group") ? value : undefined
      })
      assert.match(record, process.platform === "win32" ? /taskkill .*\/T/ : /kill group .*SIGTERM/)
      console.log(`H23 planted descendant retirement fault: ${record.trim()}`)
    }
    await absent(child, "child")
    await absent(agent, "agent")
    return status
  } finally {
    await stack.acp.release("h23-held")
    for (const row of [child, agent]) {
      if (!row) continue
      const current = readProcessRow(row.pid)
      if (current?.started === row.started) process.kill(row.pid, "SIGKILL")
    }
    await stack.close()
  }
}

async function deathAndRestart() {
  const stack = await startStack({ label: "h23-death-restart" })
  try {
    const api = new ClaxedoApi(stack.url)
    const directory = (await stack.daemon.makeWorkspace("h23-restart")).directory
    const stream = await stack.events(directory)
    await stack.acp.write("h23-dying", { steps: [{ kind: "text", text: "H23 before death" }, { kind: "hold", name: "h23-dying" }] })
    const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H23 restart" })
    await api.promptAsync(directory, session.id, `H23 first ${acpScriptToken("h23-dying")}`)
    await waitForAcpHold(stack.acp.scriptDir, "h23-dying")
    const first = readProcessRow(await agentPid(stack.acp.scriptDir))
    assert.ok(first, "ACP agent missing before injected death")
    process.kill(first.pid, "SIGKILL")
    await stream.waitFor((frame) => frameType(frame) === "session.error" && frameSessionId(frame) === session.id,
      { label: "H23 process death reported", timeoutMs: 20_000 })
    assert.equal((await api.session(directory, session.id)).lastTurn?.status, "failed")
    await stack.acp.write("h23-fresh", { steps: [{ kind: "text", text: "H23 fresh process" }] })
    await api.promptAsync(directory, session.id, `H23 next ${acpScriptToken("h23-fresh")}`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
      { label: "H23 fresh turn idle" })
    const fresh = readProcessRow(await agentPid(stack.acp.scriptDir))
    assert.ok(fresh && (fresh.pid !== first.pid || fresh.started !== first.started), "next turn did not start a fresh ACP process")
    assert.equal((await api.session(directory, session.id)).lastTurn?.status, "completed")
    assert.match(assistantText(await api.messages(directory, session.id)), /H23 fresh process/)
    console.log(`H23 killed agent ${first.pid}; failed turn stored; fresh agent ${fresh.pid} completed next turn`)
  } finally {
    await stack.acp.release("h23-dying")
    await stack.close()
  }
}

export async function run() {
  const cancelStatus = await cancelAndRetire()
  await deathAndRestart()
  if (cancelStatus !== "cancelled") throw new Error(`H-33: H23 Stop stored ${cancelStatus} instead of cancelled`)
}
