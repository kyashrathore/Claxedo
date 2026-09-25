import type { ModelKey } from "./model-key"

export type ModelSelectionSource = "ui" | "agent"

export type ModelSelectionScope = {
  readonly key: string
  readonly current?: () => ModelKey | undefined
}

export type ModelSelectionCommand = {
  readonly scope: ModelSelectionScope
  readonly model: ModelKey | undefined
  readonly source: ModelSelectionSource
  readonly recent?: boolean
}

export type ModelSelectionWriter = {
  readonly write: (command: ModelSelectionCommand) => void | Promise<void>
  readonly sync?: (command: ModelSelectionCommand) => void | Promise<void>
}

export type ModelSelectionResult =
  | { readonly changed: true; readonly model: ModelKey | undefined; readonly source: ModelSelectionSource }
  | { readonly changed: false; readonly model: ModelKey | undefined; readonly source: ModelSelectionSource; readonly reason: "unchanged" | "pending" }

export function sameModelKey(left: ModelKey | undefined, right: ModelKey | undefined) {
  if (!left || !right) return left === right
  return left.providerID === right.providerID && left.modelID === right.modelID && left.variant === right.variant
}

export function modelKeySignature(model: ModelKey | undefined) {
  if (!model) return "none"
  return `${model.providerID}\n${model.modelID}\n${model.variant ?? ""}`
}

export function modelKeyFromPickerSelection(input: { providerID?: string; modelID?: string } | undefined): ModelKey | undefined {
  if (!input?.providerID || !input.modelID) return undefined
  return { providerID: input.providerID, modelID: input.modelID }
}

export function createModelSelectionController(writer: ModelSelectionWriter) {
  const pending = new Map<string, Promise<ModelSelectionResult> | undefined>()
  return {
    set(command: ModelSelectionCommand): Promise<ModelSelectionResult> {
      return setModelSelectionWithPending(writer, pending, command)
    },
  }
}

async function setModelSelectionWithPending(
  writer: ModelSelectionWriter,
  pending: Map<string, Promise<ModelSelectionResult> | undefined>,
  command: ModelSelectionCommand,
): Promise<ModelSelectionResult> {
  const current = command.scope.current?.()
  if (sameModelKey(current, command.model)) {
    return { changed: false, model: command.model, source: command.source, reason: "unchanged" }
  }

  const key = commandKey(command)
  const existing = pending.get(key)
  if (existing) {
    await existing
    return { changed: false, model: command.model, source: command.source, reason: "pending" }
  }

  const run = writeSelection(writer, command)
  pending.set(key, run)
  try {
    return await run
  } finally {
    if (pending.get(key) === run) pending.delete(key)
  }
}

async function writeSelection(
  writer: ModelSelectionWriter,
  command: ModelSelectionCommand,
): Promise<ModelSelectionResult> {
  await writer.write(command)
  await writer.sync?.(command)
  return { changed: true, model: command.model, source: command.source }
}

function commandKey(command: ModelSelectionCommand) {
  return `${command.scope.key}\n${modelKeySignature(command.model)}`
}
