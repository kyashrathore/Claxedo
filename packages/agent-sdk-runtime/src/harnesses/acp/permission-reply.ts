import type { AgentInteractionResult } from "../../adapter-contract"
import { permissionReplied } from "../../compat-events"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import type { RuntimeAppendSource } from "../shared/turn-projection"
import type { ACPProcess } from "./process"

/** What committing a permission reply touches: the durable log and the permission → process owner map. */
export type PermissionReplyPort = {
  store: Pick<AgentRuntimeStoreWithRecovery, "appendEvent">
  owners: Map<string, ACPProcess>
}

/** The committed `permission.replied` is what drops the store row and clears the app prompt. */
export function commitPermissionReply(
  port: PermissionReplyPort,
  input: {
    sessionId: string
    agentSessionId?: string
    permId: string
    reply: "once" | "always" | "reject"
    source: RuntimeAppendSource
  },
): AgentInteractionResult | undefined {
  const committed = port.store.appendEvent({
    sessionId: input.sessionId,
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    payload: permissionReplied(input.sessionId, input.permId, input.reply),
    source: input.source,
  })
  port.owners.delete(input.permId)
  return committed?.payload ? { events: [committed.payload] } : undefined
}

/**
 * ACP cancellation contract: the client answers every outstanding
 * `session/request_permission` of the cancelled turn with `cancelled`
 * (agentclientprotocol.com/protocol/prompt-turn#cancellation). Without this
 * the request stays in the process map and the store row stays pending, so
 * the prompt outlives the turn it belonged to.
 */
export function cancelPendingPermissions(
  port: PermissionReplyPort,
  proc: ACPProcess,
  sessionId: string,
  agentSessionId: string,
) {
  // A snapshot: `respondPermission` deletes from the map being walked.
  const pendingNow = [...proc.pendingPermissions]
  for (const [permId, pending] of pendingNow) {
    if (!proc.sessionIsWithin(pending.aid, agentSessionId)) continue
    commitPermissionReply(port, {
      sessionId,
      agentSessionId,
      permId,
      reply: "reject",
      source: { dir: "out", method: "permission.abort", frame: { outcome: "cancelled" } },
    })
    proc.respondPermission(permId, { outcome: { outcome: "cancelled" } })
  }
}
