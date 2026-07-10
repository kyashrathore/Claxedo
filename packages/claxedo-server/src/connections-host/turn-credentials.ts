import { randomBytes } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"

export const CONNECTION_TURN_HEADER = "x-claxedo-connection-turn"

type TurnRecord = {
  sessionId: string
  subject?: string
  expiresAt: number
}

export type ConnectionTurnCredentials = {
  mint(input: { sessionId: string; subject?: string }): string
  resolve(credential: string | undefined): { sessionId: string; subject?: string } | undefined
  current(): string | undefined
  run<T>(credential: string, fn: () => T): T
  dispose(): void
}

export function createConnectionTurnCredentials(input: {
  now?: () => number
  ttlMs?: number
  random?: () => string
} = {}): ConnectionTurnCredentials {
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? 10 * 60_000
  const random = input.random ?? (() => randomBytes(32).toString("base64url"))
  const records = new Map<string, TurnRecord>()
  const context = new AsyncLocalStorage<string>()

  const sweep = () => {
    const timestamp = now()
    for (const [credential, record] of records) {
      if (record.expiresAt <= timestamp) records.delete(credential)
    }
  }

  const resolve = (credential: string | undefined) => {
    if (!credential) return undefined
    const record = records.get(credential)
    if (!record) return undefined
    if (record.expiresAt > now()) return { sessionId: record.sessionId, ...(record.subject ? { subject: record.subject } : {}) }
    records.delete(credential)
    return undefined
  }

  return {
    mint(turn) {
      sweep()
      const credential = random()
      records.set(credential, {
        sessionId: turn.sessionId,
        ...(turn.subject ? { subject: turn.subject } : {}),
        expiresAt: now() + ttlMs,
      })
      return credential
    },
    resolve,
    current() {
      const credential = context.getStore()
      return resolve(credential) ? credential : undefined
    },
    run(credential, fn) {
      return context.run(credential, fn)
    },
    dispose() {
      records.clear()
      context.disable()
    },
  }
}
