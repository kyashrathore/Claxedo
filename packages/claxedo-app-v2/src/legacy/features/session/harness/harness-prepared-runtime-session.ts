import {
  planPreparedHarnessSession,
  type PreparedHarnessSessionPlan,
  type PreparedHarnessSessionState,
  type PreparedRuntimeSession,
  type PreparedRuntimeSessionConfig,
  type PreparedSessionDirectory,
} from "./prepared-session"
import type { HarnessType } from "./profile"

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

function claimFailureReason(status: PreparedHarnessSessionPlan["status"]) {
  switch (status) {
    case "disabled": return "This workspace cannot start a harness session from here"
    case "missing-directory": return "The session has no workspace directory"
    case "no-model": return "Choose a model to continue"
    default: return "The harness session could not be started"
  }
}

export function createPreparedRuntimeSessionStore<ScopeInput extends { directory?: PreparedSessionDirectory; harness?: HarnessType; sessionConfig?: PreparedRuntimeSessionConfig }>(input: {
  canUseRuntimeSession(params?: ScopeInput): boolean
  state(scope: string): PreparedHarnessSessionState
  create(params: { input?: ScopeInput; directory: PreparedSessionDirectory; harness: HarnessType }): Promise<string | undefined>
  remove(item: PreparedRuntimeSession): Promise<void>
  setPrepareError(scope: string, err: unknown): void
  cache: PreparedRuntimeSessionCache
}) {
  const prepareErrors = new Map<string, unknown>()

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
    const stored = input.state(scope)
    const plan = planPreparedHarnessSession({
      enabled: input.canUseRuntimeSession(params),
      directory: params?.directory,
      // Submit already resolved the canonical runtime selection and model.
      // Prefer that claim input over the UI store: directory preparation can
      // move a draft to a new scope before that scope has hydrated.
      state: {
        harness: params?.harness ?? stored.harness,
        selectedModel: params?.sessionConfig ? params.sessionConfig.model?.modelID : stored.selectedModel,
        modelOptional: !!params?.sessionConfig && params.harness?.kind === "connection" && !params.sessionConfig.model,
      },
      ...(item ? { prepared: item } : {}),
    })
    if (plan.status !== "create") return plan.status === "reuse" ? plan.item : undefined
    if (plan.stale) void remove(take(scope))

    const id = input.cache.getSeq(scope) ?? 0
    const pending = input.cache.getPreparing(scope)
    if (pending?.seq === id) return pending.promise

    const promise = (async () => {
      try {
        prepareErrors.delete(scope)
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
        prepareErrors.set(scope, err)
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

  /**
   * Take a runtime session for a submit. A harness that cannot start one is an
   * error the submit reports, never a silent no-op: the prompt would otherwise
   * sit in the composer with nothing said.
   */
  const claim = async (scope: string, params: ScopeInput): Promise<{ id: string } | undefined> => {
    const item = await prepare(scope, params)
    if (!item) {
      if (prepareErrors.has(scope)) throw prepareErrors.get(scope)
      const plan = planPreparedHarnessSession({
        enabled: input.canUseRuntimeSession(params),
        directory: params.directory,
        state: input.state(scope),
      })
      throw new Error(claimFailureReason(plan.status))
    }
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
