import type { ApprovalDecision, ApprovalRequest, OutboundChunk } from "../envelope"
import { randomBytes } from "node:crypto"

export type ApprovalBridge = {
  request(input: ApprovalRequest): Promise<OutboundChunk>
  decide(input: ApprovalDecision & { callId: string }): Promise<{ ok: true } | { ok: false; message: string }>
  resolveToken(input: { token: string; threadKey?: string }): Promise<{ ok: true; callId: string } | { ok: false; message: string }>
}

function promptToken() {
  return randomBytes(8).toString("hex")
}

export function createMemoryApprovalBridge(options: {
  onDecision?: (request: ApprovalRequest, decision: ApprovalDecision & { callId: string }) => Promise<{ ok: true } | { ok: false; message: string }>
} = {}): ApprovalBridge {
  const pending = new Map<string, ApprovalRequest>()
  const byToken = new Map<string, string>()
  return {
    async request(input) {
      const token = input.token ?? promptToken()
      const request = { ...input, token }
      pending.set(input.callId, request)
      byToken.set(token, input.callId)
      return { kind: "approval", request }
    },
    async decide(input) {
      const request = pending.get(input.callId)
      if (!request) return { ok: false, message: "Approval request is no longer pending" }
      if (input.threadKey && request.threadKey && input.threadKey !== request.threadKey) {
        return { ok: false, message: "Approval reply did not match this channel thread." }
      }
      const result = await options.onDecision?.(request, input)
      if (result?.ok === false) return result
      pending.delete(input.callId)
      if (request.token) byToken.delete(request.token)
      return { ok: true }
    },
    async resolveToken(input) {
      const callId = byToken.get(input.token.toLowerCase())
      if (!callId) return { ok: false, message: "Approval reply did not match a pending prompt." }
      const request = pending.get(callId)
      if (input.threadKey && request?.threadKey && input.threadKey !== request.threadKey) {
        return { ok: false, message: "Approval reply did not match this channel thread." }
      }
      return { ok: true, callId }
    },
  }
}
