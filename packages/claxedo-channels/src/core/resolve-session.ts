import type { RecoveryOutcome, SessionRef } from "@claxedo/agent-runtime-contract"
import type { ChannelId, InboundEnvelope } from "../envelope"

/**
 * What asking a session to stop its turn reached. The three arms are three
 * different facts about the session, and `/new` acts on them differently: an
 * idle session has nothing to cancel and may be rebound, an owner that never
 * answered may not, and an owner that did answer carries the whole outcome —
 * including a refusal, which is the owner declining, not an idle session.
 */
export type ChannelAbortResult =
  | { kind: "no_active_turn" }
  | { kind: "outcome"; outcome: RecoveryOutcome }
  | { kind: "unreachable"; message: string }

export type ChannelSession = SessionRef & {
  threadKey: string
  channel: ChannelId
  workspaceRef?: string
  appUrl?: string
  created?: boolean
}

export type ChannelRuntime = {
  createSession(input: {
    title: string
    channel: ChannelId
    threadKey: string
    externalUserId: string
    workspaceId?: string
  }): Promise<SessionRef & { appUrl?: string; workspaceRef?: string }>
  sendMessage(input: { sessionId: string; text: string; channel: ChannelId; externalUserId: string; threadKey: string }): AsyncIterable<unknown>
  abortSession(input: { sessionId: string; channel: ChannelId; externalUserId: string; threadKey: string }): Promise<ChannelAbortResult>
}

export type SessionResolver = {
  resolve(input: InboundEnvelope): Promise<ChannelSession>
  get(threadKey: string): Promise<ChannelSession | undefined>
  /** Forget the thread→session binding so the next resolve creates fresh (/new). */
  reset?(threadKey: string): Promise<void>
}

export class ChannelSessionResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChannelSessionResolutionError"
  }
}

export function createMemorySessionResolver(runtime: ChannelRuntime): SessionResolver {
  const byThread = new Map<string, ChannelSession>()
  const pending = new Map<string, Promise<ChannelSession>>()
  return {
    async resolve(input) {
      const existing = byThread.get(input.threadKey)
      if (existing) return { ...existing, created: false }
      const inflight = pending.get(input.threadKey)
      if (inflight) return { ...await inflight, created: false }
      const creating = (async () => {
        const created = await runtime.createSession({
          title: `Channel: ${input.channel}`,
          channel: input.channel,
          threadKey: input.threadKey,
          externalUserId: input.externalUserId,
          ...(input.repo ? { workspaceId: `${input.repo.owner}/${input.repo.name}` } : {}),
        })
        const ref = {
          sessionId: created.sessionId,
          workspaceId: created.workspaceId,
          threadKey: input.threadKey,
          channel: input.channel,
          ...(created.workspaceRef ? { workspaceRef: created.workspaceRef } : {}),
          ...(created.appUrl ? { appUrl: created.appUrl } : {}),
        }
        byThread.set(input.threadKey, ref)
        return ref
      })()
      pending.set(input.threadKey, creating)
      try {
        return { ...await creating, created: true }
      } finally {
        pending.delete(input.threadKey)
      }
    },
    async get(threadKey) {
      return byThread.get(threadKey)
    },
    async reset(threadKey) {
      byThread.delete(threadKey)
      pending.delete(threadKey)
    },
  }
}
