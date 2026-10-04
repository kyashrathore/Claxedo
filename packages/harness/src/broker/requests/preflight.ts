import type { RequestAnswer } from "../../contract/broker"
import type { BrokerPorts } from "../ports"
import { hasGrant } from "../grants"
import { decisionAnswer } from "../options"
import { pendingRequest, type FiledRequest, type RequestAuthority } from "./authority"

export async function preflight(
  ports: BrokerPorts, authority: RequestAuthority, filed: FiledRequest, expiresAt?: number, signal?: AbortSignal,
): Promise<RequestAnswer | undefined> {
  if (signal?.aborted) return { kind: "cancelled" }
  const { sessionId, request } = filed
  if (request.kind === "permission" && request.permission.sessionID !== sessionId) throw new Error("Permission belongs to another session")
  if (request.kind === "question" && request.question.sessionID !== sessionId) throw new Error("Question belongs to another session")
  if (expiresAt !== undefined && expiresAt <= ports.clock.now()) {
    await ports.persistAnswer(pendingRequest(ports, authority, filed), { kind: "expired" }, false)
    return { kind: "expired" }
  }
  if (request.kind === "permission" && hasGrant(ports, authority.value.sessionId, authority.value.connectionId, request)) {
    const automatic = decisionAnswer("allow_always", request.options)
    const pending = pendingRequest(ports, authority, filed)
    if (signal?.aborted) {
      await ports.persistAnswer(pending, { kind: "cancelled" }, false)
      return { kind: "cancelled" }
    }
    await ports.persistAnswer(pending, automatic, true)
    await ports.publish({ type: "permission.auto-answered", sessionId, requestId: request.requestId, grantKey: request.grantKey! })
    return automatic
  }
  return undefined
}
