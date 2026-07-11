import {
  planPreparedHarnessSession,
  type PreparedHarnessSessionState,
  type PreparedRuntimeSession,
  type PreparedSessionDirectory,
} from "../../session/harness/prepared-session"
import type { HarnessType } from "../../session/harness/profile"

export type PreparedRuntimeSessionPending = {
  seq: number
  promise: Promise<PreparedRuntimeSession | undefined>
}

export type PreparedRuntimeSessionCache = {
  getSeq(scope: string): number | undefined
  setSeq(scope: string, value: number): void
  getPrepared(scope: string): PreparedRuntimeSession | undefined
  setPrepared(scope: string, value: PreparedRuntimeSession): void
  removePrepared(scope: string): void
  getPreparing(scope: string): PreparedRuntimeSessionPending | undefined
  setPreparing(scope: string, value: PreparedRuntimeSessionPending): void
  removePreparing(scope: string): void
}

export function createPreparedRuntimeSessionStore<ScopeInput extends { directory?: PreparedSessionDirectory }>(input: {
  canUseRuntimeSession(params?: ScopeInput): boolean
  state(scope: string): PreparedHarnessSessionState
  create(params: { input?: ScopeInput; directory: PreparedSessionDirectory; harness: HarnessType }): Promise<string | undefined>
  remove(item: PreparedRuntimeSession): Promise<void>
  setPrepareError(scope: string, err: unknown): void
  cache: PreparedRuntimeSessionCache
}) {
  const bump = (scope: string) => {
    const next = (input.cache.getSeq(scope) ?? 0) + 1
    input.cache.setSeq(scope, next)
    return next
  }

  const take = (scope: string) => {
    bump(scope)
    const item = input.cache.getPrepared(scope)
    input.cache.removePrepared(scope)
    return item
  }

  const drop = async (scope: string) => {
    const item = take(scope)
    if (item) await input.remove(item)
  }

  const prepare = async (scope: string, params?: ScopeInput): Promise<PreparedRuntimeSession | undefined> => {
    const item = input.cache.getPrepared(scope)
    const plan = planPreparedHarnessSession({
      enabled: input.canUseRuntimeSession(params),
      directory: params?.directory,
      state: input.state(scope),
      ...(item ? { prepared: item } : {}),
    })
    if (plan.status !== "create") return plan.status === "reuse" ? plan.item : undefined
    if (plan.stale) void remove(take(scope))

    const id = input.cache.getSeq(scope) ?? 0
    const pending = input.cache.getPreparing(scope)
    if (pending?.seq === id) return pending.promise

    const promise = (async () => {
      try {
        const sessionID = await input.create({
          input: params,
          directory: plan.directory,
          harness: plan.harness,
        })
        if (!sessionID) throw new Error("Failed to initialize harness")
        const next = {
          id: sessionID,
          directory: plan.directory,
          harness: plan.harness,
          model: plan.model,
        } satisfies PreparedRuntimeSession
        if ((input.cache.getSeq(scope) ?? 0) !== id) {
          await input.remove(next)
          return undefined
        }
        input.cache.setPrepared(scope, next)
        return next
      } catch (err) {
        if ((input.cache.getSeq(scope) ?? 0) !== id) return undefined
        input.setPrepareError(scope, err)
        return undefined
      }
    })()

    input.cache.setPreparing(scope, { seq: id, promise })
    return promise.finally(() => {
      const current = input.cache.getPreparing(scope)
      if (current?.seq === id && current.promise === promise) input.cache.removePreparing(scope)
    })
  }

  const claim = async (scope: string, params?: ScopeInput): Promise<{ id: string } | undefined> => {
    if (input.state(scope).harness === "opencode") return undefined
    const item = await prepare(scope, params)
    if (!item) return undefined
    take(scope)
    return { id: item.id }
  }

  const remove = async (item?: PreparedRuntimeSession) => {
    if (!item) return
    await input.remove(item)
  }

  return {
    claim,
    drop,
    prepare,
    take,
  }
}
