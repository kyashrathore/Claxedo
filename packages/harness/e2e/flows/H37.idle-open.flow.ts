import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { ApiError, ClaxedoApi } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"

/** The pid the scripted ACP agent writes as it starts; a new one means the daemon launched another agent. */
const agentPid = async (scriptDir: string) => (await readFile(path.join(scriptDir, "agent.pid"), "utf8")).trim()

export async function run() {
  const stack = await startStack({ label: "h37-idle-open" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h37-idle-open")
    const acp = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
    const pi = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
    await stack.daemon.restart()
    const launched = await agentPid(stack.acp.scriptDir)
    const reached = (await readAcpRequests(stack.acp.scriptDir)).length

    assert.deepEqual(await api.todos(workspace.directory, acp.id), [])
    assert.equal((await api.goalState(workspace.directory, acp.id)).goal, null)
    const attached = (await readAcpRequests(stack.acp.scriptDir)).slice(reached).map((request) => request.method)
    assert.deepEqual(attached, [], `H-NEW-mergefix-1: opening an idle ACP session attached it: ${attached.join(", ")}`)
    assert.equal(await agentPid(stack.acp.scriptDir), launched, "H-NEW-mergefix-1: opening an idle ACP session launched its agent")

    const refusal = await api.todos(workspace.directory, pi.id).then(() => undefined, (error: unknown) => error)
    assert.ok(refusal instanceof ApiError && refusal.status === 409, `H-NEW-mergefix-1: Pi todos of an idle session answered ${String(refusal)}`)
    assert.deepEqual(stack.scripted.requests, [])
  } finally {
    await stack.close()
  }
}
