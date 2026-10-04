import { acpScriptToken, ClaxedoApi, frameSessionId, frameType, SCRIPTED_ACP_HARNESS, scriptedAgentPids, startStack, type StreamFrame } from "../harness"
import { prepareHarness } from "../harness/global-setup"

function pushedHealth(frame: StreamFrame) {
  const data = frame.data as { payload?: { properties?: Record<string, unknown> }; properties?: Record<string, unknown> }
  const properties = data.payload?.properties ?? data.properties
  const connection = properties?.connectionState as { state?: string } | undefined
  return JSON.stringify({ health: properties?.harnessHealth, connection: connection?.state })
}

async function main() {
  await prepareHarness()
  const stack = await startStack({ label: "probe-harness-health" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("health")
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { title: "health", harness: SCRIPTED_ACP_HARNESS })
    const read = async (label: string) => {
      const body = await api.harnessStatus(workspace.id, session.id)
      console.log(`[probe] ${label}: harnessHealth=${JSON.stringify(body.harnessHealth)} connection=${body.connectionState?.state}`)
    }
    await stack.acp.write("health-hold", { steps: [{ kind: "text", text: "Before the kill" }, { kind: "hold", name: "health-hold" }] })
    await api.promptAsync(workspace.directory, session.id, `Hold ${acpScriptToken("health-hold")}`)
    await stream.waitFor((frame) => frameSessionId(frame) === session.id && frameType(frame) === "message.part.delta", { label: "first delta" })
    await read("mid-turn")
    const beforeKill = new Set(stream.frames)
    for (const pid of scriptedAgentPids(stack.daemon.port)) process.kill(pid, "SIGKILL")
    await stream.waitFor((frame) => !beforeKill.has(frame) && frameType(frame) === "harness.health", { label: "health after the kill" })
    await read("after the kill")
    await stack.acp.write("health-after", { steps: [{ kind: "text", text: "After recovery" }] })
    const beforeNext = new Set(stream.frames)
    await api.promptAsync(workspace.directory, session.id, `Again ${acpScriptToken("health-after")}`)
    await stream.waitFor((frame) => !beforeNext.has(frame) && frameSessionId(frame) === session.id && (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "the next turn's end", timeoutMs: 60_000 })
    await read("after the next turn")
    for (const frame of stream.frames.filter((candidate) => frameType(candidate) === "harness.health")) console.log(`[probe] harness.health ${pushedHealth(frame)}`)
    stream.close()
  } finally {
    await stack.close()
  }
}

await main()
