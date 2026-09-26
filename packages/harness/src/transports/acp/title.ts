import type { McpServer, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { AcpTransportError } from "./errors"
import type { AcpEntry } from "./index"

export type AcpTitleLaunch = { mcpServers: McpServer[]; meta?: NewSessionRequest["_meta"] }

export async function acpSessionTitle(entry: AcpEntry, request: SessionTitleRequest, launch: AcpTitleLaunch): Promise<string | null> {
  if (request.signal.aborted) throw new AcpTransportError("timeout", "ACP title request was abandoned")
  const started = await entry.peer.agent.newSession({ cwd: request.directory, mcpServers: launch.mcpServers, ...(launch.meta ? { _meta: launch.meta } : {}) })
  let text = ""
  entry.sideSessions.set(started.sessionId, (update) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text
  })
  const onAbort = () => {
    void entry.peer.agent.cancel({ sessionId: started.sessionId }).catch((error: unknown) => entry.broker.reportFailure(error))
  }
  request.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const result = await entry.peer.agent.prompt({ sessionId: started.sessionId,
      prompt: [{ type: "text", text: `${request.system}\n\n${request.user}` }] })
    if (result.stopReason === "cancelled" || request.signal.aborted) return null
    return text.trim() ? text : null
  } finally {
    request.signal.removeEventListener("abort", onAbort)
    entry.sideSessions.delete(started.sessionId)
  }
}
