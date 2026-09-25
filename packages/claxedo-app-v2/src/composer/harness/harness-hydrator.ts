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

type HydratorInput<ScopeInput extends HarnessScopeInput> = {
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
}

type Run<ScopeInput> = {
  readonly scope: string
  readonly key: string
  readonly params: ScopeInput
  readonly placementId: PlacementId
  readonly draftDefault?: { readonly saved?: DraftDefault }
  readonly active: () => boolean
}

export function createHarnessHydrator<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>) {
  const runs = createRunTracker(input.cache)
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
    return runs.start(scope, key, async (active) => {
      const placementId = params?.placementId
      if (!params || !placementId) return
      const run = { scope, key, params, placementId, draftDefault, active }
      await (existingSession ? hydrateSession(input, run) : hydrateDraft(input, run))
    })
  }
  return {
    // An explicit user selection owns the scope immediately. Any hydration
    // already waiting on its status read must not apply its older server snapshot
    // after that click and silently restore the previous harness.
    cancel: runs.cancel,
    hydrate,
    // Re-run a single hydration probe for a scope that is still "polling". Hydrate
    // is one-shot (guarded by the per-scope "seen" stamp), so a bounded re-probe
    // must first CLEAR that stamp; otherwise hydrate early-returns and the harness
    // stays Connecting forever. Any probe already in flight is deduped by the
    // pending guard inside `hydrate`, so re-probing never stacks requests.
    reprobe: async (scope: string, params?: ScopeInput) => {
      input.cache.clearSeen(scope)
      return hydrate(scope, params)
    },
  }
}

/** One hydration per scope and stamp: a repeat joins the one in flight, and a newer one or a cancel retires it. */
function createRunTracker<ScopeInput extends HarnessScopeInput>(cache: HarnessHydratorCache<ScopeInput>) {
  const generations = new Map<string, number>()
  const pending = new Map<string, { key: string; run: Promise<void> }>()
  let nextGeneration = 0
  return {
    cancel: (scope: string) => void generations.delete(scope),
    start: (scope: string, key: string, work: (active: () => boolean) => Promise<void>) => {
      const joined = pending.get(scope)
      if (joined?.key === key) return joined.run
      const generation = ++nextGeneration
      generations.set(scope, generation)
      const run = work(() => generations.get(scope) === generation)
      pending.set(scope, { key, run })
      cache.setPending(scope, run)
      return run.finally(() => {
        if (pending.get(scope)?.run === run) pending.delete(scope)
        if (generations.get(scope) === generation) generations.delete(scope)
        cache.removePending(scope, run)
      })
    },
  }
}

async function hydrateDraft<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, run: Run<ScopeInput>) {
  const { scope, params, active } = run
  if (run.draftDefault?.saved) {
    if (!active()) return
    const type = input.state(scope)?.harness ?? run.draftDefault.saved.harness
    if (await settleOnHarness(input, scope, type, params) && active()) input.cache.setSeen(scope, run.key)
    return
  }
  if (shouldHydrateDraftFromHarnessStatus({ placementKind: input.runtime.placementKind(run.placementId) })) {
    const data = await readHarnessStatus(input, params)
    if (!active()) return
    if (data) return applyAndMarkSeen(input, run, data)
  }
  const type = input.state(scope)?.harness
  if (type && !await settleOnHarness(input, scope, type, params)) return
  if (active()) input.cache.setSeen(scope, run.key)
}

async function hydrateSession<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, run: Run<ScopeInput>) {
  const data = await readHarnessStatus(input, run.params)
  if (!run.active()) return
  if (data) return applyAndMarkSeen(input, run, data)
  // A missing/failed config is not evidence that the existing session
  // belongs to a different harness. Keep it retryable and, when the
  // session's row names its harness, expose that harness while the
  // model/config is still connecting.
  input.setPollingHydration(run.scope, run.params.sessionHarness)
}

async function applyAndMarkSeen<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, run: Run<ScopeInput>, data: HarnessState) {
  if (!run.active()) return
  await input.applyStatus(run.scope, data, run.params)
  if (run.active()) input.cache.setSeen(run.scope, run.key)
}

/** Marks `type` ready and loads its options when it has any; false when its capabilities could not be read. */
async function settleOnHarness<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, scope: string, type: HarnessType, params: ScopeInput) {
  input.setReadyHydration(scope, type)
  const configOptions = await probeConfigOptions(input, scope, type)
  if (configOptions === undefined) return false
  if (configOptions) await input.fetchConfigOptions(scope, type, params)
  else input.setReadyHydration(scope, type, false)
  return true
}

async function probeConfigOptions<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, scope: string, type: HarnessType) {
  try {
    return input.hasConfigOptions ? await input.hasConfigOptions(type) : harnessHasConfigOptions(type)
  } catch (error) {
    input.setCapabilityError?.(scope, error instanceof Error ? error.message : "Failed to load connection capabilities")
    return undefined
  }
}

function readHarnessStatus<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, params: ScopeInput): Promise<HarnessState | undefined> {
  const placementId = params.placementId
  if (!placementId) return Promise.resolve(undefined)
  if (params.sessionId && params.sessionId !== "new") return readSessionHarness(input, params)
  return input.runtime.folderHarness(placementId).catch((error: unknown) => {
    console.warn(`The harness status of placement ${placementId} could not be read`, error)
    return undefined
  })
}

async function readSessionHarness<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, params: ScopeInput): Promise<HarnessState | undefined> {
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
  if (refType && config) return { type: refType, activeType: refType, ready: false, status: "error", error: "Session harness configuration is unavailable" }
  // Existing-session identity comes only from its persisted config. A
  // directory harness status describes the workspace default, not this
  // conversation, so falling through would overwrite Codex ownership with
  // an unrelated OpenCode selection after a transient config failure.
  return undefined
}

function stamp(input?: HarnessScopeInput) {
  if (input?.sessionId && input.sessionId !== "new") {
    return [`session:${input.sessionId}`, input.placementId ?? "", input.sessionHarness ? JSON.stringify(input.sessionHarness) : ""].join("\n")
  }
  return `${input?.placementId ?? ""}\nnew`
}
