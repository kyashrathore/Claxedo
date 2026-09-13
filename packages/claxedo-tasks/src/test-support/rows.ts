import type {
  ConfigurationSlot,
  ModelConfiguration,
  Preset,
  PresetDraft,
  Task,
  TaskSessionLink,
} from "../contracts"
import type { TasksCommandReceipt } from "../ports/store"

export const SCOPES = { first: "scope-alpha", second: "scope-beta" } as const

export const OWNER = "owner-alpha"

export function primaryConfiguration(overrides: Partial<ModelConfiguration> = {}): ModelConfiguration {
  return {
    harness: overrides.harness ?? { id: "claude", access: "native" },
    model: overrides.model ?? { providerID: "anthropic", modelID: "claude-sonnet" },
    effort: overrides.effort ?? null,
  }
}

export function presetDraft(overrides: Partial<PresetDraft> = {}): PresetDraft {
  return {
    name: overrides.name ?? "Local preset",
    instructions: overrides.instructions ?? "Work carefully.",
    execution: overrides.execution ?? { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: overrides.configurations ?? { primary: primaryConfiguration() },
  }
}

export function slotted(slot: Exclude<ConfigurationSlot, "primary">, configuration = primaryConfiguration()): PresetDraft {
  return presetDraft({ configurations: { primary: primaryConfiguration(), [slot]: configuration } })
}

export function presetRow(input: Partial<Preset> & Pick<Preset, "id">): Preset {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scopeId: input.scopeId ?? SCOPES.first,
    ownerId: input.ownerId ?? OWNER,
    name: input.name ?? "Local preset",
    instructions: input.instructions ?? "",
    execution: input.execution ?? { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: input.configurations ?? { primary: primaryConfiguration() },
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  }
}

/**
 * A number of its own for every row a test writes, because a durable adapter
 * keys `(scope, project, number)` uniquely. Keyed by task id, so a test that
 * inserts a row and then updates it under the same id carries one number
 * through both.
 */
const taskNumbers = new Map<string, number>()

function taskNumberFor(taskId: string): number {
  const held = taskNumbers.get(taskId)
  if (held !== undefined) return held
  const minted = taskNumbers.size + 1
  taskNumbers.set(taskId, minted)
  return minted
}

export function taskRow(input: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scopeId: input.scopeId ?? SCOPES.first,
    projectId: input.projectId ?? "project-alpha",
    number: input.number ?? taskNumberFor(input.id),
    workspaceId: input.workspaceId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    createdFrom: input.createdFrom ?? null,
    title: input.title ?? "Ship the thing",
    description: input.description ?? "",
    status: input.status ?? "todo",
    childSetRevision: input.childSetRevision ?? 0,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  }
}

export function linkRow(input: Partial<TaskSessionLink> & Pick<TaskSessionLink, "taskId" | "attempt">): TaskSessionLink {
  const slot: ConfigurationSlot = input.slot ?? "primary"
  return {
    scopeId: input.scopeId ?? SCOPES.first,
    taskId: input.taskId,
    slot,
    attempt: input.attempt,
    sessionRef: input.sessionRef ?? { sessionId: `session-${input.taskId}-${slot}-${input.attempt}`, workspaceId: null },
    continuedFrom: input.continuedFrom ?? null,
    presetId: input.presetId ?? "preset-1",
    presetRevision: input.presetRevision ?? 1,
    presetNameAtStart: input.presetNameAtStart ?? "Local preset",
    configurationDigest: input.configurationDigest ?? "c".repeat(64),
    handoffText: input.handoffText ?? null,
    createdAt: input.createdAt ?? 2_000,
  }
}

export function receiptRow(
  input: Partial<TasksCommandReceipt> & Pick<TasksCommandReceipt, "clientRequestId" | "result">,
): TasksCommandReceipt {
  return {
    scopeId: input.scopeId ?? SCOPES.first,
    clientRequestId: input.clientRequestId,
    commandName: input.commandName ?? "task.create",
    requestHash: input.requestHash ?? "hash-a",
    result: input.result,
    createdAt: input.createdAt ?? 3_000,
  }
}
