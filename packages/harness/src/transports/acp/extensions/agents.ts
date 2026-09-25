import type { ClientSideConnection } from "@agentclientprotocol/sdk"
import type { AgentAgent } from "@claxedo/agent-runtime-contract"
import type { ConfigTarget, DraftLaunch, HarnessSession } from "../../../contract"
import type { AcpEntry } from "../index"
import { AcpTransportError } from "../errors"

export async function acpAgentList(peer: ClientSideConnection, upstreamSessionId: string): Promise<AgentAgent[]> {
  const response = await peer.extMethod("session/agents/list", { sessionId: upstreamSessionId })
  if (!Array.isArray(response.agents)) throw new AcpTransportError("protocol", "ACP agent list response is invalid")
  const agents: AgentAgent[] = []
  const values: unknown[] = response.agents
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AcpTransportError("protocol", "ACP agent list response is invalid")
    const row = Object.fromEntries(Object.entries(value))
    if (typeof row.name !== "string" || (row.description !== undefined && typeof row.description !== "string") ||
      (row.mode !== undefined && typeof row.mode !== "string")) throw new AcpTransportError("protocol", "ACP agent list response is invalid")
    agents.push({ name: row.name,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.mode === "string" ? { mode: row.mode } : {}) })
  }
  return agents
}

export function acpAgentOperations(entry: (session: HarnessSession) => AcpEntry, probe: (draft: DraftLaunch) => Promise<AgentAgent[]>) {
  return { list: (target: ConfigTarget) => "session" in target
    ? acpAgentList(entry(target.session).peer.agent, target.session.binding.upstreamSessionId) : probe(target.draft) }
}
