import type { McpServer, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk"
import type { AttachInput } from "../../../contract"
import type { AcpPeer } from "../connection"
import { AcpTransportError } from "../errors"

export type AcpRestoreInput = Omit<AttachInput, "upstreamHasTurns">

export type AcpRestored = {
  upstreamSessionId: string
  modes?: SessionModeState | null
  configOptions?: SessionConfigOption[] | null
}

export async function restoreAcp(peer: AcpPeer, input: AcpRestoreInput, mcpServers: McpServer[]): Promise<AcpRestored> {
  const upstream = input.binding.upstreamSessionId
  const capabilities = peer.handshake.agentCapabilities
  try {
    if (capabilities?.sessionCapabilities?.resume) {
      const restored = await peer.agent.resumeSession({ sessionId: upstream, cwd: input.directory, mcpServers })
      return { upstreamSessionId: upstream, modes: restored.modes, configOptions: restored.configOptions }
    }
    if (capabilities?.loadSession) {
      const loaded = await peer.agent.loadSession({ sessionId: upstream, cwd: input.directory, mcpServers })
      return { upstreamSessionId: upstream, modes: loaded.modes, configOptions: loaded.configOptions }
    }
    throw new AcpTransportError("protocol", "ACP agent declares neither load nor resume")
  } catch (error) {
    if (!lostAttachedSession(error, upstream)) throw error
    throw new AcpTransportError("session", `ACP agent no longer has session ${upstream}; it is not replaced`, error)
  }
}

function lostAttachedSession(error: unknown, sessionId: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== -32002) return false
  const data = "data" in error ? error.data : undefined
  if (!data || typeof data !== "object") return false
  return ("uri" in data && data.uri === sessionId) || ("sessionId" in data && data.sessionId === sessionId)
}
