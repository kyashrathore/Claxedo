import { harnessHasConfigOptions, type HarnessType } from "./profile"
import type { HarnessStoreState } from "./store-state"
import type { DraftDefault } from "./draft-defaults"
import type { DraftDefaultApplication } from "./draft-default-policy"
import type { HarnessState, PlacementId, PlacementKind, SessionConfig, SessionRef } from "@/server"
import {
  harnessStateFromSessionConfig,
  shouldHydrateDraftFromHarnessStatus,
  type HarnessScopeInput,
} from "./store-policy"

export type HarnessHydratorCache<ScopeInput extends HarnessScopeInput> = {
  getSeen(scope: string): string | undefined
  setSeen(scope: string, key: string): void
  clearSeen(scope: string): void
  getPending(scope: string): Promise<void> | undefined
  setPending(scope: string, value: Promise<void>): void
  removePending(scope: string, value: Promise<void>): void
  fetchSessionConfig(params: ScopeInput, run: () => Promise<SessionConfig | undefined>): Promise<SessionConfig | undefined>
}

export function createHarnessHydrator<ScopeInput extends HarnessScopeInput>(input: {
  seed(scope: string): void
  state(scope: string): HarnessStoreState | undefined
  beginDraftDefault?(scope: string, params?: ScopeInput): {
    application: DraftDefaultApplication
    saved?: DraftDefault
  } | undefined
  markServer?(scope: string): void
  applyStatus(scope: string, data: HarnessState, params?: ScopeInput): Promise<void>
  setPollingHydration(scope: string, type?: HarnessType): void
  setReadyHydration(scope: string, type: HarnessType, hasConfigOptions?: boolean): void
  setCapabilityError?(scope: string, message: string): void
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): Promise<unknown> | void
  hasConfigOptions?(type: HarnessType): Promise<boolean>
  runtime: {
    placementKind(placementId: PlacementId): PlacementKind | undefined
    folderHarness(placementId: PlacementId): Promise<HarnessState | undefined>
    sessionConfig(ref: SessionRef): Promise<SessionConfig | undefined>
  }
  cache: HarnessHydratorCache<ScopeInput>
}) {
  const generations = new Map<string, number>()
  const pendingByScope = new Map<string, { key: string; run: Promise<void> }>()
  let nextGeneration = 0

  const hasConfigOptions = async (scope: string, type: HarnessType) => {
    try {
      return input.hasConfigOptions ? await input.hasConfigOptions(type) : harnessHasConfigOptions(type)
    } catch (error) {
      input.setCapabilityError?.(scope, error instanceof Error ? error.message : "Failed to load connection capabilities")
      return undefined
    }
  }

  const status = async (params?: ScopeInput): Promise<HarnessState | undefined> => {
    const placementId = params?.placementId
    if (!params || !placementId) return undefined
    const sessionId = params.sessionId
    if (sessionId && sessionId !== "new") {
      const ref = params.sessionRef
      if (!ref) return undefined
      const config = await input.cache.fetchSessionConfig(params, () => input.runtime.sessionConfig(ref)).catch((error: unknown) => {
        console.warn(`The harness config of session ${ref.sessionId} could not be read`, error)
        return null
      })
      const hit = config ? harnessStateFromSessionConfig(config) : undefined
      if (hit) return hit
      // A successful object response is not a transport retry. If it violates
      // the existing-session config contract by omitting harness identity, keep
      // the harness the session's row names visible and settle as unavailable
      // instead of polling forever or exposing the seeded OpenCode selection.
      const refType = params.sessionHarness
      if (refType && config) {
        return {
          type: refType,
          activeType: refType,
          ready: false,
          status: "error",
          error: "Session harness configuration is unavailable",
        }
      }
      // Existing-session identity comes only from its persisted config. A
      // directory harness status describes the workspace default, not this
      // conversation, so falling through would overwrite Codex ownership with
      // an unrelated OpenCode selection after a transient config failure.
      return undefined
    }
    return await input.runtime.folderHarness(placementId).catch((error: unknown) => {
      console.warn(`The harness status of placement ${placementId} could not be read`, error)
      return undefined
    })
  }

  const hydrate = async (scope: string, params?: ScopeInput) => {
    input.seed(scope)
    const key = stamp(params)
    const existingSession = !!params?.sessionId && params.sessionId !== "new"
    // The session still runs its own harness under a held pick, so its config
    // describes the harness the user just picked away from.
    if (existingSession && input.state(scope)?.heldFrom) return
    if (existingSession) input.markServer?.(scope)
    const draftDefault = existingSession ? undefined : input.beginDraftDefault?.(scope, params)
    // The draft harness selection persists across directory switches — the
    // embedded local runtime backs every harness, so a user's choice is never
    // force-reset to OpenCode when navigating between workspaces.
    if (input.cache.getSeen(scope) === key) return
    const pending = pendingByScope.get(scope)
    if (pending?.key === key) return pending.run
    const generation = ++nextGeneration
    generations.set(scope, generation)
    const active = () => generations.get(scope) === generation

    const run = (async () => {
      const placementId = params?.placementId
      if (!params || !placementId) return
      if (!params.sessionId || params.sessionId === "new") {
        if (draftDefault?.saved) {
          if (!active()) return
          const type = input.state(scope)?.harness ?? draftDefault.saved.harness
          input.setReadyHydration(scope, type)
          const configOptions = await hasConfigOptions(scope, type)
          if (configOptions === undefined) return
          if (configOptions) await input.fetchConfigOptions(scope, type, params)
          else input.setReadyHydration(scope, type, false)
          if (active()) input.cache.setSeen(scope, key)
          return
        }
        if (shouldHydrateDraftFromHarnessStatus({ placementKind: input.runtime.placementKind(placementId) })) {
          const data = await status(params)
          if (!active()) return
          if (data) {
            await applyAndMarkSeen(scope, data, params, key, active)
            return
          }
        }
        const type = input.state(scope)?.harness
        if (type) {
          input.setReadyHydration(scope, type)
          const configOptions = await hasConfigOptions(scope, type)
          if (configOptions === undefined) return
          if (configOptions) await input.fetchConfigOptions(scope, type, params)
          else input.setReadyHydration(scope, type, false)
        }
        if (active()) input.cache.setSeen(scope, key)
        return
      }
      const data = await status(params)
      if (!active()) return
      if (!data) {
        // A missing/failed config is not evidence that the existing session
        // belongs to a different harness. Keep it retryable and, when the
        // session's row names its harness, expose that harness while the
        // model/config is still connecting.
        input.setPollingHydration(scope, params.sessionHarness)
        return
      }
      await applyAndMarkSeen(scope, data, params, key, active)
    })()

    pendingByScope.set(scope, { key, run })
    input.cache.setPending(scope, run)
    return run.finally(() => {
      if (pendingByScope.get(scope)?.run === run) pendingByScope.delete(scope)
      if (generations.get(scope) === generation) generations.delete(scope)
      input.cache.removePending(scope, run)
    })
  }

  const applyAndMarkSeen = async (
    scope: string,
    data: HarnessState,
    params: ScopeInput,
    key: string,
    active: () => boolean,
  ) => {
    if (!active()) return
    await input.applyStatus(scope, data, params)
    if (active()) input.cache.setSeen(scope, key)
  }

  // Re-run a single hydration probe for a scope that is still "polling". Hydrate
  // is one-shot (guarded by the per-scope "seen" stamp), so a bounded re-probe
  // must first CLEAR that stamp; otherwise hydrate early-returns and the harness
  // stays Connecting forever. Any probe already in flight is deduped by the
  // pending guard inside `hydrate`, so re-probing never stacks requests.
  const reprobe = async (scope: string, params?: ScopeInput) => {
    input.cache.clearSeen(scope)
    return hydrate(scope, params)
  }

  // An explicit user selection owns the scope immediately. Any hydration
  // already waiting on its status read must not apply its older server snapshot
  // after that click and silently restore the previous harness.
  const cancel = (scope: string) => {
    generations.delete(scope)
  }

  return {
    cancel,
    hydrate,
    reprobe,
    status,
  }
}

function stamp(input?: HarnessScopeInput) {
  if (input?.sessionId && input.sessionId !== "new") {
    return [`session:${input.sessionId}`, input.placementId ?? "", input.sessionHarness ? JSON.stringify(input.sessionHarness) : ""].join("\n")
  }
  return `${input?.placementId ?? ""}\nnew`
}
