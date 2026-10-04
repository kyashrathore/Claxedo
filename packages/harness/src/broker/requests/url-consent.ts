import type { RequestAnswer, TurnRequest } from "../../contract/broker"
import type { RequestAuthority } from "./authority"

function urlConsentKey(connectionId: string, elicitationId: string): string {
  return JSON.stringify([connectionId, elicitationId])
}

function consentKey(authority: RequestAuthority, request: TurnRequest): string | undefined {
  return request.kind === "elicitation" && request.mode === "url" && request.elicitationId
    ? urlConsentKey(authority.value.connectionId, request.elicitationId) : undefined
}

export class UrlConsentAdmissions {
  private readonly outstanding = new Map<string, Set<string>>()

  async admit(authority: RequestAuthority, request: TurnRequest, ask: () => Promise<RequestAnswer>): Promise<RequestAnswer> {
    const key = consentKey(authority, request)
    const sessionId = authority.value.sessionId
    if (key && this.outstanding.get(sessionId)?.has(key)) throw new Error(`Duplicate outstanding elicitationId ${JSON.stringify([sessionId, key])}`)
    if (key) this.add(sessionId, key)
    try {
      const answer = await ask()
      if (key && (answer.kind !== "consent" || !answer.accepted)) this.remove(sessionId, key)
      return answer
    } catch (error) {
      if (key) this.remove(sessionId, key)
      throw error
    }
  }

  complete(sessionId: string, connectionId: string, elicitationId: string): void {
    this.remove(sessionId, urlConsentKey(connectionId, elicitationId))
  }

  clearSession(sessionId: string): void {
    this.outstanding.delete(sessionId)
  }

  private add(sessionId: string, key: string): void {
    const keys = this.outstanding.get(sessionId) ?? new Set<string>()
    keys.add(key)
    this.outstanding.set(sessionId, keys)
  }

  private remove(sessionId: string, key: string): void {
    const keys = this.outstanding.get(sessionId)
    if (!keys) return
    keys.delete(key)
    if (!keys.size) this.outstanding.delete(sessionId)
  }
}
