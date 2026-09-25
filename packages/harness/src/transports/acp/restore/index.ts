import type { McpServer } from "@agentclientprotocol/sdk"
import type { SessionHandoff } from "@claxedo/agent-runtime-contract"
import type { AttachInput, SessionBroker } from "../../../contract"
import type { AcpPeer } from "../connection"
import { AcpTransportError } from "../errors"

export type MissingSessionContext = (input: AttachInput) => Promise<SessionHandoff>

export async function restoreAcp(peer: AcpPeer, input: AttachInput, mcpServers: McpServer[], broker: SessionBroker, missingContext: MissingSessionContext): Promise<string> {
  const upstream = input.binding.upstreamSessionId
  const capabilities = peer.handshake.agentCapabilities
  try {
    if (capabilities?.sessionCapabilities?.resume) {
      await peer.agent.resumeSession({ sessionId: upstream, cwd: input.directory, mcpServers })
      return upstream
    }
    if (capabilities?.loadSession) {
      await peer.agent.loadSession({ sessionId: upstream, cwd: input.directory, mcpServers })
      return upstream
    }
    throw new AcpTransportError("protocol", "ACP agent declares neither load nor resume")
  } catch (error) {
    if (!lostAttachedSession(error, upstream)) throw error
    const context = await missingContext(input)
    await broker.persistHandoff(context)
    const result = await peer.agent.newSession({ cwd: input.directory, mcpServers })
    return result.sessionId
  }
}

function lostAttachedSession(error: unknown, sessionId: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== -32002) return false
  const data = "data" in error ? error.data : undefined
  if (!data || typeof data !== "object") return false
  return ("uri" in data && data.uri === sessionId) || ("sessionId" in data && data.sessionId === sessionId)
}
