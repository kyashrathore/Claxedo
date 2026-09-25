import type { PendingRequest, TurnRequest } from "../../contract/broker"
import type { RequestAuthority } from "./authority"

type ConsentEntry = { pending: PendingRequest; authority: RequestAuthority }

function consentKey(authority: RequestAuthority, request: TurnRequest): string | undefined {
  return request.kind === "elicitation" && request.mode === "url" && request.elicitationId
    ? JSON.stringify([authority.value.sessionId, authority.value.connectionId, request.elicitationId]) : undefined
}

export class UrlConsentAdmissions {
  private readonly outstanding = new Set<string>()

  async admit<T>(authority: RequestAuthority, request: TurnRequest, ask: () => Promise<T>): Promise<T> {
    const key = consentKey(authority, request)
    if (key && this.outstanding.has(key)) throw new Error(`Duplicate outstanding elicitationId ${key}`)
    if (key) this.outstanding.add(key)
    try {
      return await ask()
    } finally {
      if (key) this.outstanding.delete(key)
    }
  }
}

export function findUrlConsent<E extends ConsentEntry>(
  entries: Iterable<E>, sessionId: string, connectionId: string, elicitationId: string,
): E | undefined {
  for (const entry of entries) {
    const request = entry.pending.request
    if (entry.pending.sessionId === sessionId && entry.authority.value.connectionId === connectionId &&
      request.kind === "elicitation" && request.mode === "url" && request.elicitationId === elicitationId) return entry
  }
  return undefined
}
