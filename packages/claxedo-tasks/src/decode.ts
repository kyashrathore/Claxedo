import {
  SESSION_HANDOFF_STATES,
  SESSION_LIVENESS,
  START_BLOCKER_CODES,
  isConfigurationSlot,
  isTaskAttachmentMime,
  isTaskStatus,
  isTasksCommandName,
  type ConfigurationSlot,
  type ModelConfiguration,
  type Page,
  type PluginReference,
  type Preset,
  type PresetConfigurations,
  type PresetExecution,
  type SessionHandoffState,
  type SessionLiveness,
  type SessionReference,
  type SkillReference,
  type StartBlocker,
  type StartPreview,
  type Task,
  type TaskAttachment,
  type TaskDetailResponse,
  type TaskSessionLinkView,
  type TaskStatus,
  type TaskSummary,
  type TasksCapabilities,
  type TasksCommandResult,
  type TasksBounds,
  type TasksCommandResultByName,
} from "./contracts"
import { decodeContext, finishDecode, type DecodeContext, type Parsed } from "./validation"

/**
 * Decoders for the shapes that cross the wire in both directions. A client
 * reads a server response through the same readers a route reads a request
 * with, so neither side has to claim a type nothing checked.
 */

function decodePluginReference(ctx: DecodeContext, value: unknown, path: string): PluginReference {
  const row = ctx.read.record(value, path)
  return {
    sourceId: ctx.read.nonEmptyString(row?.sourceId, `${path}.sourceId`) ?? "",
    pluginName: ctx.read.nonEmptyString(row?.pluginName, `${path}.pluginName`) ?? "",
  }
}

function decodeSkillReference(ctx: DecodeContext, value: unknown, path: string): SkillReference {
  const row = ctx.read.record(value, path)
  return {
    sourceId: ctx.read.nonEmptyString(row?.sourceId, `${path}.sourceId`) ?? "",
    skillName: ctx.read.nonEmptyString(row?.skillName, `${path}.skillName`) ?? "",
  }
}

export function decodeExecution(ctx: DecodeContext, value: unknown, path: string): PresetExecution {
  const row = ctx.read.record(value, path)
  const placement = ctx.read.string(row?.placement, `${path}.placement`)
  const capabilities = ctx.read.record(row?.capabilities, `${path}.capabilities`)
  const mode = ctx.read.string(capabilities?.mode, `${path}.capabilities.mode`)

  if (placement === "local") {
    if (mode !== "inherit-local") ctx.fields.add(`${path}.capabilities.mode`, "unknown_value")
    // A local preset carrying a selection would read as an enforced allowlist
    // the host never applies, so the keys are refused rather than ignored.
    if (capabilities && "plugins" in capabilities) ctx.fields.add(`${path}.capabilities.plugins`, "not_allowed")
    if (capabilities && "skills" in capabilities) ctx.fields.add(`${path}.capabilities.skills`, "not_allowed")
    return { placement: "local", capabilities: { mode: "inherit-local" } }
  }

  if (placement !== "cloud") {
    if (placement !== undefined) ctx.fields.add(`${path}.placement`, "unknown_value")
    return { placement: "local", capabilities: { mode: "inherit-local" } }
  }

  if (mode !== "selected") ctx.fields.add(`${path}.capabilities.mode`, "unknown_value")
  const plugins = ctx.read.array(capabilities?.plugins, `${path}.capabilities.plugins`) ?? []
  const skills = ctx.read.array(capabilities?.skills, `${path}.capabilities.skills`) ?? []
  return {
    placement: "cloud",
    capabilities: {
      mode: "selected",
      plugins: plugins.map((entry, index) => decodePluginReference(ctx, entry, `${path}.capabilities.plugins[${index}]`)),
      skills: skills.map((entry, index) => decodeSkillReference(ctx, entry, `${path}.capabilities.skills[${index}]`)),
    },
  }
}

function decodeModelConfiguration(ctx: DecodeContext, value: unknown, path: string): ModelConfiguration {
  const row = ctx.read.record(value, path)
  const harness = ctx.read.record(row?.harness, `${path}.harness`)
  const access = ctx.read.string(harness?.access, `${path}.harness.access`)
  if (access !== undefined && access !== "native" && access !== "connection") {
    ctx.fields.add(`${path}.harness.access`, "unknown_value")
  }
  const model = ctx.read.record(row?.model, `${path}.model`)
  return {
    harness: {
      id: ctx.read.nonEmptyString(harness?.id, `${path}.harness.id`) ?? "",
      access: access === "connection" ? "connection" : "native",
    },
    model: {
      providerID: ctx.read.nonEmptyString(model?.providerID, `${path}.model.providerID`) ?? "",
      modelID: ctx.read.nonEmptyString(model?.modelID, `${path}.model.modelID`) ?? "",
    },
    effort: ctx.read.nullableString(row?.effort, `${path}.effort`) ?? null,
  }
}

export function decodeConfigurations(ctx: DecodeContext, value: unknown, path: string): PresetConfigurations {
  const row = ctx.read.record(value, path)
  const primary = decodeModelConfiguration(ctx, row?.primary, `${path}.primary`)
  const optional: Partial<Record<Exclude<ConfigurationSlot, "primary">, ModelConfiguration>> = {}
  for (const key of Object.keys(row ?? {})) {
    if (!isConfigurationSlot(key)) {
      ctx.fields.add(`${path}.${key}`, "unknown_value")
      continue
    }
    if (key === "primary") continue
    optional[key] = decodeModelConfiguration(ctx, row?.[key], `${path}.${key}`)
  }
  return { primary, ...optional }
}

function taskStatusOf(ctx: DecodeContext, value: unknown, path: string): TaskStatus {
  const raw = ctx.read.string(value, path)
  if (raw !== undefined && !isTaskStatus(raw)) ctx.fields.add(path, "unknown_value")
  return isTaskStatus(raw) ? raw : "todo"
}

export function decodeSlot(ctx: DecodeContext, value: unknown, path: string): ConfigurationSlot {
  const raw = ctx.read.string(value, path)
  if (raw !== undefined && !isConfigurationSlot(raw)) ctx.fields.add(path, "unknown_value")
  return isConfigurationSlot(raw) ? raw : "primary"
}

function liveness(ctx: DecodeContext, value: unknown, path: string): SessionLiveness {
  const raw = ctx.read.string(value, path)
  const known = SESSION_LIVENESS.find((candidate) => candidate === raw)
  if (!known && raw !== undefined) ctx.fields.add(path, "unknown_value")
  return known ?? "unavailable"
}

function handoffState(ctx: DecodeContext, value: unknown, path: string): SessionHandoffState {
  const raw = ctx.read.string(value, path)
  const known = SESSION_HANDOFF_STATES.find((candidate) => candidate === raw)
  if (!known && raw !== undefined) ctx.fields.add(path, "unknown_value")
  return known ?? "unknown"
}

export function decodeSessionReference(ctx: DecodeContext, value: unknown, path: string): SessionReference {
  const row = ctx.read.record(value, path)
  return {
    sessionId: ctx.read.nonEmptyString(row?.sessionId, `${path}.sessionId`) ?? "",
    workspaceId: ctx.read.nullableString(row?.workspaceId, `${path}.workspaceId`) ?? null,
  }
}

function nullableSessionReference(ctx: DecodeContext, value: unknown, path: string): SessionReference | null {
  if (value === null) return null
  return decodeSessionReference(ctx, value, path)
}

function nullableInteger(ctx: DecodeContext, value: unknown, path: string): number | null {
  if (value === null) return null
  return ctx.read.integer(value, path) ?? null
}

function presetOf(ctx: DecodeContext, value: unknown, path: string): Preset {
  const row = ctx.read.record(value, path)
  return {
    id: ctx.read.nonEmptyString(row?.id, `${path}.id`) ?? "",
    revision: ctx.read.integer(row?.revision, `${path}.revision`) ?? 0,
    scopeId: ctx.read.nonEmptyString(row?.scopeId, `${path}.scopeId`) ?? "",
    ownerId: ctx.read.nonEmptyString(row?.ownerId, `${path}.ownerId`) ?? "",
    name: ctx.read.string(row?.name, `${path}.name`) ?? "",
    instructions: ctx.read.string(row?.instructions, `${path}.instructions`) ?? "",
    execution: decodeExecution(ctx, row?.execution, `${path}.execution`),
    configurations: decodeConfigurations(ctx, row?.configurations, `${path}.configurations`),
    agentStartable: ctx.read.boolean(row?.agentStartable, `${path}.agentStartable`) ?? false,
    archivedAt: nullableInteger(ctx, row?.archivedAt, `${path}.archivedAt`),
    createdAt: ctx.read.integer(row?.createdAt, `${path}.createdAt`) ?? 0,
    updatedAt: ctx.read.integer(row?.updatedAt, `${path}.updatedAt`) ?? 0,
  }
}

function taskOf(ctx: DecodeContext, value: unknown, path: string): Task {
  const row = ctx.read.record(value, path)
  return {
    id: ctx.read.nonEmptyString(row?.id, `${path}.id`) ?? "",
    revision: ctx.read.integer(row?.revision, `${path}.revision`) ?? 0,
    scopeId: ctx.read.nonEmptyString(row?.scopeId, `${path}.scopeId`) ?? "",
    projectId: ctx.read.nonEmptyString(row?.projectId, `${path}.projectId`) ?? "",
    number: ctx.read.integer(row?.number, `${path}.number`) ?? 0,
    workspaceId: ctx.read.nullableString(row?.workspaceId, `${path}.workspaceId`) ?? null,
    parentTaskId: ctx.read.nullableString(row?.parentTaskId, `${path}.parentTaskId`) ?? null,
    createdFrom: nullableSessionReference(ctx, row?.createdFrom, `${path}.createdFrom`),
    title: ctx.read.string(row?.title, `${path}.title`) ?? "",
    description: ctx.read.string(row?.description, `${path}.description`) ?? "",
    status: taskStatusOf(ctx, row?.status, `${path}.status`),
    childSetRevision: ctx.read.integer(row?.childSetRevision, `${path}.childSetRevision`) ?? 0,
    archivedAt: nullableInteger(ctx, row?.archivedAt, `${path}.archivedAt`),
    createdAt: ctx.read.integer(row?.createdAt, `${path}.createdAt`) ?? 0,
    updatedAt: ctx.read.integer(row?.updatedAt, `${path}.updatedAt`) ?? 0,
  }
}

function taskSummaryOfValue(ctx: DecodeContext, value: unknown, path: string): TaskSummary {
  const row = ctx.read.record(value, path)
  // A summary row carries no description by contract, so the decoder supplies
  // the one field the shared task decoder requires and drops it again.
  const { description: _description, ...task } = taskOf(ctx, { ...row, description: "" }, path)
  const links = ctx.read.record(row?.links, `${path}.links`)
  const children = ctx.read.record(row?.children, `${path}.children`)
  return {
    ...task,
    hasDescription: ctx.read.boolean(row?.hasDescription, `${path}.hasDescription`) ?? false,
    links: { count: ctx.read.integer(links?.count, `${path}.links.count`) ?? 0 },
    children: {
      total: ctx.read.integer(children?.total, `${path}.children.total`) ?? 0,
      done: ctx.read.integer(children?.done, `${path}.children.done`) ?? 0,
    },
  }
}

function linkViewOf(ctx: DecodeContext, value: unknown, path: string): TaskSessionLinkView {
  const row = ctx.read.record(value, path)
  return {
    taskId: ctx.read.nonEmptyString(row?.taskId, `${path}.taskId`) ?? "",
    slot: decodeSlot(ctx, row?.slot, `${path}.slot`),
    attempt: ctx.read.integer(row?.attempt, `${path}.attempt`) ?? 0,
    sessionRef: decodeSessionReference(ctx, row?.sessionRef, `${path}.sessionRef`),
    continuedFrom: nullableSessionReference(ctx, row?.continuedFrom, `${path}.continuedFrom`),
    presetId: ctx.read.nonEmptyString(row?.presetId, `${path}.presetId`) ?? "",
    presetRevision: ctx.read.integer(row?.presetRevision, `${path}.presetRevision`) ?? 0,
    presetNameAtStart: ctx.read.string(row?.presetNameAtStart, `${path}.presetNameAtStart`) ?? "",
    createdAt: ctx.read.integer(row?.createdAt, `${path}.createdAt`) ?? 0,
    liveness: liveness(ctx, row?.liveness, `${path}.liveness`),
    handoff: handoffState(ctx, row?.handoff, `${path}.handoff`),
  }
}

function attachmentOf(ctx: DecodeContext, value: unknown, path: string): TaskAttachment {
  const row = ctx.read.record(value, path)
  const mime = ctx.read.string(row?.mime, `${path}.mime`)
  if (mime !== undefined && !isTaskAttachmentMime(mime)) ctx.fields.add(`${path}.mime`, "unknown_value")
  return {
    id: ctx.read.nonEmptyString(row?.id, `${path}.id`) ?? "",
    filename: ctx.read.nonEmptyString(row?.filename, `${path}.filename`) ?? "",
    mime: isTaskAttachmentMime(mime) ? mime : "image/png",
    size: ctx.read.integer(row?.size, `${path}.size`) ?? 0,
    createdAt: ctx.read.integer(row?.createdAt, `${path}.createdAt`) ?? 0,
  }
}

function blockerOf(ctx: DecodeContext, value: unknown, path: string): StartBlocker {
  const row = ctx.read.record(value, path)
  const code = ctx.read.string(row?.code, `${path}.code`)
  const known = START_BLOCKER_CODES.find((candidate) => candidate === code)
  if (code !== undefined && !known) ctx.fields.add(`${path}.code`, "unknown_value")
  return {
    code: known ?? "capability_unavailable",
    detail: ctx.read.string(row?.detail, `${path}.detail`) ?? "",
  }
}

function startPreviewOf(ctx: DecodeContext, value: unknown, path: string): StartPreview {
  const row = ctx.read.record(value, path)
  const placement = ctx.read.string(row?.placement, `${path}.placement`)
  if (placement !== "local" && placement !== "cloud") ctx.fields.add(`${path}.placement`, "unknown_value")
  const capabilities = decodeExecution(
    ctx,
    { placement: placement === "cloud" ? "cloud" : "local", capabilities: row?.capabilities },
    path,
  ).capabilities
  const current = row?.currentSession
  const hasCurrent = current !== null && current !== undefined
  const currentRow = hasCurrent ? ctx.read.record(current, `${path}.currentSession`) : undefined
  const blockers = ctx.read.array(row?.blockers, `${path}.blockers`) ?? []
  return {
    digest: ctx.read.nonEmptyString(row?.digest, `${path}.digest`) ?? "",
    expiresAt: ctx.read.integer(row?.expiresAt, `${path}.expiresAt`) ?? 0,
    placement: placement === "cloud" ? "cloud" : "local",
    slot: decodeSlot(ctx, row?.slot, `${path}.slot`),
    attempt: ctx.read.integer(row?.attempt, `${path}.attempt`) ?? 0,
    configuration: decodeModelConfiguration(ctx, row?.configuration, `${path}.configuration`),
    capabilities,
    available: ctx.read.boolean(row?.available, `${path}.available`) ?? false,
    blockers: blockers.map((entry, index) => blockerOf(ctx, entry, `${path}.blockers[${index}]`)),
    currentSession: hasCurrent
      ? {
          sessionRef: decodeSessionReference(ctx, currentRow?.sessionRef, `${path}.currentSession.sessionRef`),
          liveness: liveness(ctx, currentRow?.liveness, `${path}.currentSession.liveness`),
        }
      : null,
    previousTranscriptReadable: ctx.read.boolean(row?.previousTranscriptReadable, `${path}.previousTranscriptReadable`) ?? false,
    destinationDescription: ctx.read.string(row?.destinationDescription, `${path}.destinationDescription`) ?? "",
  }
}

function decodePage<T>(ctx: DecodeContext, value: unknown, path: string, item: (entry: unknown, itemPath: string) => T): Page<T> {
  const row = ctx.read.record(value, path)
  const items = ctx.read.array(row?.items, `${path}.items`) ?? []
  return {
    items: items.map((entry, index) => item(entry, `${path}.items[${index}]`)),
    nextCursor: ctx.read.nullableString(row?.nextCursor, `${path}.nextCursor`) ?? null,
  }
}

export function decodePreset(value: unknown): Parsed<Preset> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => presetOf(ctx, value, "preset"))
}

export function decodeTask(value: unknown): Parsed<Task> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => taskOf(ctx, value, "task"))
}

export function decodePresetPage(value: unknown): Parsed<Page<Preset>> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => decodePage(ctx, value, "page", (entry, path) => presetOf(ctx, entry, path)))
}

export function decodeTaskSummaryPage(value: unknown): Parsed<Page<TaskSummary>> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => decodePage(ctx, value, "page", (entry, path) => taskSummaryOfValue(ctx, entry, path)))
}

export function decodeTaskDetail(value: unknown): Parsed<TaskDetailResponse> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => {
    const row = ctx.read.record(value, "body")
    const links = ctx.read.array(row?.links, "body.links") ?? []
    const attachments = ctx.read.array(row?.attachments, "body.attachments") ?? []
    return {
      task: taskOf(ctx, row?.task, "body.task"),
      links: links.map((entry, index) => linkViewOf(ctx, entry, `body.links[${index}]`)),
      attachments: attachments.map((entry, index) => attachmentOf(ctx, entry, `body.attachments[${index}]`)),
    }
  })
}

export function decodeStartResponse(value: unknown): Parsed<{ link: TaskSessionLinkView; created: boolean }> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => {
    const row = ctx.read.record(value, "body")
    return {
      link: linkViewOf(ctx, row?.link, "body.link"),
      created: ctx.read.boolean(row?.created, "body.created") ?? false,
    }
  })
}

export function decodeStartPreviewResponse(value: unknown): Parsed<{ preview: StartPreview }> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => {
    const row = ctx.read.record(value, "body")
    return { preview: startPreviewOf(ctx, row?.preview, "body.preview") }
  })
}

export function decodeCapabilitiesResponse(value: unknown): Parsed<TasksCapabilities> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => {
    const row = ctx.read.record(value, "body")
    const placements = ctx.read.array(row?.placements, "body.placements") ?? []
    const slots = ctx.read.array(row?.configurationSlots, "body.configurationSlots") ?? []
    return {
      protocolVersion: ctx.read.integer(row?.protocolVersion, "body.protocolVersion") ?? 0,
      placements: placements.map((entry, index) => {
        const placement = ctx.read.string(entry, `body.placements[${index}]`)
        if (placement !== "local" && placement !== "cloud") {
          ctx.fields.add(`body.placements[${index}]`, "unknown_value")
          return "local"
        }
        return placement
      }),
      cloudSelectedCapabilities: ctx.read.boolean(row?.cloudSelectedCapabilities, "body.cloudSelectedCapabilities") ?? false,
      configurationSlots: slots.map((entry, index) => decodeSlot(ctx, entry, `body.configurationSlots[${index}]`)),
      bounds: boundsOf(ctx, row?.bounds),
    }
  })
}

function boundsOf(ctx: DecodeContext, value: unknown): TasksBounds {
  const row = ctx.read.record(value, "body.bounds")
  const bound = (key: keyof TasksBounds) => ctx.read.integer(row?.[key], `body.bounds.${key}`) ?? 0
  return {
    presetNameMax: bound("presetNameMax"),
    instructionsMaxBytes: bound("instructionsMaxBytes"),
    taskTitleMax: bound("taskTitleMax"),
    taskDescriptionMaxBytes: bound("taskDescriptionMaxBytes"),
    pluginReferencesMax: bound("pluginReferencesMax"),
    skillReferencesMax: bound("skillReferencesMax"),
    handoffTextMaxBytes: bound("handoffTextMaxBytes"),
    taskAttachmentsMax: bound("taskAttachmentsMax"),
    taskAttachmentMaxBytes: bound("taskAttachmentMaxBytes"),
    taskAttachmentFilenameMax: bound("taskAttachmentFilenameMax"),
    listLimitDefault: bound("listLimitDefault"),
    listLimitMax: bound("listLimitMax"),
    commandRequestMaxBytes: bound("commandRequestMaxBytes"),
    startRequestMaxBytes: bound("startRequestMaxBytes"),
  }
}

function commandResultOf(ctx: DecodeContext, value: unknown, path: string): TasksCommandResult {
  const row = ctx.read.record(value, path)
  const name = ctx.read.string(row?.type, `${path}.type`)
  if (!isTasksCommandName(name)) {
    if (name !== undefined) ctx.fields.add(`${path}.type`, "unknown_value")
    return { type: "preset.create", preset: presetOf(ctx, row?.preset, `${path}.preset`) }
  }
  switch (name) {
    case "preset.create":
    case "preset.edit":
    case "preset.archive":
    case "preset.restore":
      return { type: name, preset: presetOf(ctx, row?.preset, `${path}.preset`) }
    case "task.create":
    case "task.edit":
    case "task.set_status":
    case "task.reparent":
    case "task.archive":
    case "task.restore": {
      const mutation: TasksCommandResultByName["task.create"] = {
        task: taskOf(ctx, row?.task, `${path}.task`),
        parent: row?.parent === null || row?.parent === undefined ? null : taskOf(ctx, row?.parent, `${path}.parent`),
      }
      return { type: name, ...mutation }
    }
    default: {
      const exhaustive: never = name
      return exhaustive
    }
  }
}

export function decodeCommandResponse(value: unknown): Parsed<{ result: TasksCommandResult; replayed: boolean }> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => {
    const row = ctx.read.record(value, "body")
    return {
      result: commandResultOf(ctx, row?.result, "body.result"),
      replayed: ctx.read.boolean(row?.replayed, "body.replayed") ?? false,
    }
  })
}
