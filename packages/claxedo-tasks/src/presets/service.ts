import type {
  Page,
  Preset,
  PresetArchiveInput,
  PresetCreateInput,
  PresetDraft,
  PresetEditInput,
  PresetListQuery,
  PresetRestoreInput,
  TasksActor,
} from "../contracts"
import { refuse, refuseInvalid } from "../errors"
import type { HarnessDescriptor, TasksCapabilitiesPort } from "../ports/capabilities"
import type { TasksClockPort } from "../ports/clock"
import type { TasksIdsPort } from "../ports/ids"
import type { TasksStoreOperations } from "../ports/store"
import { draftHarnesses, validatePresetDraft } from "./model"

export type PresetsServiceDeps = {
  store: TasksStoreOperations
  clock: TasksClockPort
  ids: TasksIdsPort
  capabilities: TasksCapabilitiesPort
}

export type PresetsService = {
  list(actor: TasksActor, query: PresetListQuery): Promise<Page<Preset>>
  get(actor: TasksActor, presetId: string): Promise<Preset>
  create(actor: TasksActor, input: PresetCreateInput): Promise<Preset>
  edit(actor: TasksActor, input: PresetEditInput): Promise<Preset>
  archive(actor: TasksActor, input: PresetArchiveInput): Promise<Preset>
  restore(actor: TasksActor, input: PresetRestoreInput): Promise<Preset>
}

function harnessLookupKey(reference: { id: string; access: string }): string {
  return `${reference.access}:${reference.id}`
}

export function createPresetsService(deps: PresetsServiceDeps): PresetsService {
  // A preset belonging to another owner in the same scope is reported missing,
  // not forbidden: a personal catalog does not disclose that a name exists.
  const owned = async (actor: TasksActor, presetId: string): Promise<Preset> => {
    const preset = await deps.store.presets.get(actor.scopeId, presetId)
    if (!preset || preset.scopeId !== actor.scopeId || preset.ownerId !== actor.ownerId) {
      refuse("not_found", `Preset ${presetId} was not found`)
    }
    return preset
  }

  const atRevision = (preset: Preset, revision: number): Preset => {
    if (preset.revision !== revision) {
      refuse("stale_revision", `Preset ${preset.id} is at revision ${preset.revision}`, { currentPreset: preset })
    }
    return preset
  }

  const validated = async (draft: PresetDraft): Promise<PresetDraft> => {
    const host = await deps.capabilities.describe()
    if (!host.placements.includes(draft.execution.placement)) {
      refuse("unsupported", `This host does not support ${draft.execution.placement} execution`)
    }
    if (draft.execution.placement === "cloud" && !host.cloudSelectedCapabilities) {
      refuse("unsupported", "This host cannot honour a selected cloud capability set")
    }
    const descriptors = new Map<string, HarnessDescriptor>()
    for (const reference of draftHarnesses(draft)) {
      const key = harnessLookupKey(reference)
      if (descriptors.has(key)) continue
      const descriptor = await deps.capabilities.harness(reference)
      if (descriptor) descriptors.set(key, descriptor)
    }
    const checked = validatePresetDraft(draft, (reference) => descriptors.get(harnessLookupKey(reference)))
    if (!checked.ok) refuseInvalid("The preset is not valid", checked.fields)
    return checked.value
  }

  const write = async (next: Preset, expectedRevision: number): Promise<Preset> => {
    const stored = await deps.store.presets.update(next, expectedRevision)
    if (!stored) refuse("stale_revision", `Preset ${next.id} changed while it was being saved`)
    return next
  }

  return {
    async list(actor, query) {
      return deps.store.presets.list(actor.scopeId, actor.ownerId, query)
    },

    async get(actor, presetId) {
      return owned(actor, presetId)
    },

    async create(actor, input) {
      const draft = await validated(input)
      const now = deps.clock.now()
      const preset: Preset = {
        id: deps.ids.presetId(),
        revision: 1,
        scopeId: actor.scopeId,
        ownerId: actor.ownerId,
        name: draft.name,
        instructions: draft.instructions,
        execution: draft.execution,
        configurations: draft.configurations,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await deps.store.presets.insert(preset)
      return preset
    },

    async edit(actor, input) {
      const current = atRevision(await owned(actor, input.presetId), input.revision)
      const draft = await validated(input)
      return write(
        {
          ...current,
          revision: current.revision + 1,
          name: draft.name,
          instructions: draft.instructions,
          execution: draft.execution,
          configurations: draft.configurations,
          updatedAt: deps.clock.now(),
        },
        input.revision,
      )
    },

    async archive(actor, input) {
      const current = atRevision(await owned(actor, input.presetId), input.revision)
      if (current.archivedAt !== null) refuse("conflict", `Preset ${current.id} is already archived`)
      const now = deps.clock.now()
      return write({ ...current, revision: current.revision + 1, archivedAt: now, updatedAt: now }, input.revision)
    },

    async restore(actor, input) {
      const current = atRevision(await owned(actor, input.presetId), input.revision)
      if (current.archivedAt === null) refuse("conflict", `Preset ${current.id} is not archived`)
      return write(
        { ...current, revision: current.revision + 1, archivedAt: null, updatedAt: deps.clock.now() },
        input.revision,
      )
    },
  }
}
