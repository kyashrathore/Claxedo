import type { RequestAnswer, TurnRequest } from "../../contract/broker"
import type { RequestAuthority } from "./authority"

function urlConsentKey(sessionId: string, connectionId: string, elicitationId: string): string {
  return JSON.stringify([sessionId, connectionId, elicitationId])
}

function consentKey(authority: RequestAuthority, request: TurnRequest): string | undefined {
  return request.kind === "elicitation" && request.mode === "url" && request.elicitationId
    ? urlConsentKey(authority.value.sessionId, authority.value.connectionId, request.elicitationId) : undefined
}

export class UrlConsentAdmissions {
  private readonly outstanding = new Set<string>()

  async admit(authority: RequestAuthority, request: TurnRequest, ask: () => Promise<RequestAnswer>): Promise<RequestAnswer> {
    const key = consentKey(authority, request)
    if (key && this.outstanding.has(key)) throw new Error(`Duplicate outstanding elicitationId ${key}`)
    if (key) this.outstanding.add(key)
    try {
      const answer = await ask()
      if (key && (answer.kind !== "consent" || !answer.accepted)) this.outstanding.delete(key)
      return answer
    } catch (error) {
      if (key) this.outstanding.delete(key)
      throw error
    }
  }

  complete(sessionId: string, connectionId: string, elicitationId: string): void {
    this.outstanding.delete(urlConsentKey(sessionId, connectionId, elicitationId))
  }
}
