import type { WorkbenchState } from "../../claxedo-ui/workbench"
import type { ContentMeta } from "../../claxedo-ui/state"
import { emptyClaxedoState } from "../../claxedo-ui/state/persistence"
import { defaultLayoutConfig, layoutMigrate, type LayoutConfig, type LayoutTarget } from "../layout/config"
import type { HarnessProfile } from "../harnesses/profile"
import { harnessProfileFromLegacy, type HarnessKind } from "../harnesses/profile"
import { createRehydrator, type CacheStore } from "./rehydrator"

export type ProjectionScope = {
  userId: string
  workspaceId?: string
}

export type ProjectionEnvelope<TType extends string, TValue> = {
  type: TType
  version: 1
  scope: ProjectionScope
  updatedAt: number
  value: TValue
}

export type WorkbenchProjectionValue = {
  layout: LayoutConfig
  workbench: WorkbenchState
  meta: Record<string, ContentMeta>
}

export type WorkbenchProjection = ProjectionEnvelope<"workbench", WorkbenchProjectionValue>

export type HarnessConfigProjectionValue = {
  profiles: HarnessProfile[]
  selectedHarnessIdBySession: Record<string, string | undefined>
}

export type HarnessConfigProjection = ProjectionEnvelope<"harness-config", HarnessConfigProjectionValue>

export function projectionScopeKey(scope: ProjectionScope) {
  return `${scope.userId}:${scope.workspaceId ?? "global"}`
}

export function workbenchProjectionKey(scope: ProjectionScope) {
  return `projection:workbench:${projectionScopeKey(scope)}`
}

export function harnessConfigProjectionKey(scope: ProjectionScope) {
  return `projection:harness-config:${projectionScopeKey(scope)}`
}

export function isProjectionCacheKey(key: string) {
  return key.startsWith("projection:workbench:") || key.startsWith("projection:harness-config:")
}

export function createWorkbenchProjection(input: {
  scope: ProjectionScope
  value?: Partial<WorkbenchProjectionValue>
  updatedAt?: number
  target?: LayoutTarget
}): WorkbenchProjection {
  const empty = emptyClaxedoState()
  return {
    type: "workbench",
    version: 1,
    scope: input.scope,
    updatedAt: input.updatedAt ?? Date.now(),
    value: {
      layout: input.value?.layout ?? defaultLayoutConfig({ target: input.target }),
      workbench: input.value?.workbench ?? empty.workbench,
      meta: input.value?.meta ?? empty.meta,
    },
  }
}

export function createHarnessConfigProjection(input: {
  scope: ProjectionScope
  profiles?: HarnessProfile[]
  selectedHarnessIdBySession?: Record<string, string | undefined>
  updatedAt?: number
}): HarnessConfigProjection {
  return {
    type: "harness-config",
    version: 1,
    scope: input.scope,
    updatedAt: input.updatedAt ?? Date.now(),
    value: {
      profiles: input.profiles ?? [],
      selectedHarnessIdBySession: input.selectedHarnessIdBySession ?? {},
    },
  }
}

export function migrateWorkbenchProjection(input: {
  scope: ProjectionScope
  stored: unknown
  target?: LayoutTarget
  updatedAt?: number
}) {
  const raw = record(input.stored)
  if (raw?.type === "workbench" && raw.version === 1) {
    const value = record(raw.value)
    const migrated = layoutMigrate(value?.layout, { target: input.target })
    return {
      projection: createWorkbenchProjection({
        scope: input.scope,
        value: {
          layout: migrated.config,
          workbench: isWorkbenchState(value?.workbench) ? value.workbench : undefined,
          meta: contentMetaMap(value?.meta),
        },
        updatedAt: numberOr(raw.updatedAt, input.updatedAt),
        target: input.target,
      }),
      dirty: migrated.dirty || JSON.stringify(raw.scope) !== JSON.stringify(input.scope),
    }
  }

  const empty = emptyClaxedoState()
  const layout = layoutMigrate(raw, { target: input.target })
  return {
    projection: createWorkbenchProjection({
      scope: input.scope,
      value: {
        layout: layout.config,
        workbench: isWorkbenchState(raw?.workbench) ? raw.workbench : empty.workbench,
        meta: contentMetaMap(raw?.meta) ?? empty.meta,
      },
      updatedAt: input.updatedAt,
      target: input.target,
    }),
    dirty: true,
  }
}

export function migrateHarnessConfigProjection(input: {
  scope: ProjectionScope
  stored: unknown
  updatedAt?: number
}) {
  const raw = record(input.stored)
  if (raw?.type === "harness-config" && raw.version === 1) {
    const value = record(raw.value)
    return {
      projection: createHarnessConfigProjection({
        scope: input.scope,
        profiles: harnessProfiles(value?.profiles),
        selectedHarnessIdBySession: stringRecord(value?.selectedHarnessIdBySession ?? value?.selectedRunnerIdBySession),
        updatedAt: numberOr(raw.updatedAt, input.updatedAt),
      }),
      dirty: JSON.stringify(raw.scope) !== JSON.stringify(input.scope),
    }
  }

  return {
    projection: createHarnessConfigProjection({
      scope: input.scope,
      profiles: harnessProfiles(raw?.profiles ?? raw?.runners),
      selectedHarnessIdBySession: stringRecord(raw?.selectedHarnessIdBySession ?? raw?.selectedRunnerIdBySession),
      updatedAt: input.updatedAt,
    }),
    dirty: true,
  }
}

export async function clearProjectionCacheOnSignOut(input: {
  cache: CacheStore
  scope: ProjectionScope
}) {
  await input.cache.delete(workbenchProjectionKey(input.scope))
  await input.cache.delete(harnessConfigProjectionKey(input.scope))
}

export function createWorkbenchProjectionRehydrator(input: {
  cache: CacheStore
  scope: ProjectionScope
  loadLive: () => Promise<WorkbenchProjection | undefined>
}) {
  return createRehydrator({
    key: workbenchProjectionKey(input.scope),
    cache: input.cache,
    loadLive: input.loadLive,
  })
}

export function createHarnessConfigProjectionRehydrator(input: {
  cache: CacheStore
  scope: ProjectionScope
  loadLive: () => Promise<HarnessConfigProjection | undefined>
}) {
  return createRehydrator({
    key: harnessConfigProjectionKey(input.scope),
    cache: input.cache,
    loadLive: input.loadLive,
  })
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return Object.fromEntries(Object.entries(input))
}

function numberOr(input: unknown, fallback = Date.now()) {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback
}

function isWorkbenchState(input: unknown): input is WorkbenchState {
  const raw = record(input)
  return !!raw && Array.isArray(raw.panes) && Array.isArray(raw.contentIds) && Array.isArray(raw.contentRecency)
}

function contentMetaMap(input: unknown) {
  const raw = record(input)
  if (!raw) return
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, ContentMeta] => {
      const value = record(entry[1])
      return typeof value?.id === "string" && typeof value.type === "string"
    }),
  )
}

function stringRecord(input: unknown): Record<string, string | undefined> {
  const raw = record(input)
  if (!raw) return {}
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function harnessProfiles(input: unknown): HarnessProfile[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const raw = record(item)
    if (!raw || typeof raw.kind !== "string" || typeof raw.model !== "string" && !record(raw.model)) return []
    const kind = raw.kind as HarnessKind
    return [
      harnessProfileFromLegacy({
        id: typeof raw.id === "string" ? raw.id : undefined,
        kind,
        label: typeof raw.label === "string" ? raw.label : undefined,
        model: typeof raw.model === "string"
          ? raw.model
          : {
              providerID: String(record(raw.model)?.providerID ?? kind),
              modelID: String(record(raw.model)?.modelID ?? "default"),
            },
        credentialRef: typeof raw.credentialRef === "string" ? raw.credentialRef : undefined,
        scope: raw.scope === "workspace" || raw.scope === "org" || raw.scope === "user" ? raw.scope : undefined,
        workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : undefined,
      }),
    ]
  })
}
