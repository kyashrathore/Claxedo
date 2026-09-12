import type {
  TasksActor,
  TasksCommand,
  TasksCommandRequest,
  TasksCommandResponse,
  TasksCommandResult,
} from "./contracts"
import { TasksError, refuse } from "./errors"
import { hashRequest } from "./hash"
import type { TasksAuthorizationPort } from "./ports/authorization"
import type { TasksCapabilitiesPort } from "./ports/capabilities"
import type { TasksClockPort } from "./ports/clock"
import type { TasksIdsPort } from "./ports/ids"
import type { TasksSessionBridgePort } from "./ports/session-bridge"
import { TasksStoreConflict, joinedTransaction, type TasksStoreOperations, type TasksStorePort } from "./ports/store"
import { createPresetsService } from "./presets/service"
import { createTasksService } from "./tasks/service"

export type TasksCommandsDeps = {
  store: TasksStorePort
  clock: TasksClockPort
  ids: TasksIdsPort
  capabilities: TasksCapabilitiesPort
  authorization: TasksAuthorizationPort
  bridge: TasksSessionBridgePort
}

export type TasksCommands = {
  execute(actor: TasksActor, request: TasksCommandRequest): Promise<TasksCommandResponse>
}

export function createTasksCommands(deps: TasksCommandsDeps): TasksCommands {
  const services = (operations: TasksStoreOperations) => {
    const store = joinedTransaction(operations)
    return {
      presets: createPresetsService({ store, clock: deps.clock, ids: deps.ids, capabilities: deps.capabilities }),
      tasks: createTasksService({
        store,
        clock: deps.clock,
        ids: deps.ids,
        authorization: deps.authorization,
        bridge: deps.bridge,
      }),
    }
  }

  const run = async (actor: TasksActor, command: TasksCommand, operations: TasksStoreOperations): Promise<TasksCommandResult> => {
    const { presets, tasks } = services(operations)
    switch (command.type) {
      case "preset.create":
        return { type: command.type, preset: await presets.create(actor, command.input) }
      case "preset.edit":
        return { type: command.type, preset: await presets.edit(actor, command.input) }
      case "preset.archive":
        return { type: command.type, preset: await presets.archive(actor, command.input) }
      case "preset.restore":
        return { type: command.type, preset: await presets.restore(actor, command.input) }
      case "task.create":
        return { type: command.type, ...(await tasks.create(actor, command.input)) }
      case "task.edit":
        return { type: command.type, ...(await tasks.edit(actor, command.input)) }
      case "task.set_status":
        return { type: command.type, ...(await tasks.setStatus(actor, command.input)) }
      case "task.reparent":
        return { type: command.type, ...(await tasks.reparent(actor, command.input)) }
      case "task.archive":
        return { type: command.type, ...(await tasks.archive(actor, command.input)) }
      case "task.restore":
        return { type: command.type, ...(await tasks.restore(actor, command.input)) }
      default: {
        const exhaustive: never = command
        return exhaustive
      }
    }
  }

  // A replay proves nothing about current access. The record the receipt
  // committed is resolved again under this actor's authority, so a revoked
  // project or a preset that changed hands cannot be read back out of a
  // receipt written while access still held.
  const reauthorize = async (actor: TasksActor, result: TasksCommandResult): Promise<void> => {
    const { presets, tasks } = services(deps.store)
    switch (result.type) {
      case "preset.create":
      case "preset.edit":
      case "preset.archive":
      case "preset.restore":
        await presets.get(actor, result.preset.id)
        return
      case "task.create":
      case "task.edit":
      case "task.set_status":
      case "task.reparent":
      case "task.archive":
      case "task.restore":
        await tasks.requireWritable(actor, result.task.id)
        return
      default: {
        const exhaustive: never = result
        return exhaustive
      }
    }
  }

  const replay = async (actor: TasksActor, request: TasksCommandRequest, requestHash: string): Promise<TasksCommandResponse> => {
    const receipt = await deps.store.receipts.get(actor.scopeId, request.clientRequestId)
    if (!receipt) refuse("conflict", `Client request ${request.clientRequestId} could not be replayed`)
    if (receipt.requestHash !== requestHash) {
      refuse("conflict", `Client request ${request.clientRequestId} already committed a different command`)
    }
    await reauthorize(actor, receipt.result)
    return { result: receipt.result, replayed: true }
  }

  return {
    async execute(actor, request) {
      const requestHash = await hashRequest(request.command)
      const committedAlready = () => deps.store.receipts.get(actor.scopeId, request.clientRequestId)

      // The receipt is read and written inside the unit it describes, so a
      // duplicate an arbitrated store admits only after the first one
      // committed finds the taken key instead of running its command against
      // a revision that commit has already moved. An adapter that cannot
      // decide the key until it commits reports the same collision
      // afterwards, once every operation in the unit has already answered — a
      // duplicate is still the committed command, so it replays; a revision or
      // origin this unit lost to a real competitor is a refusal.
      let raced = false
      const result = await deps.store
        .transaction(async (operations) => {
          if (await operations.receipts.get(actor.scopeId, request.clientRequestId)) return undefined
          const committed = await run(actor, request.command, operations)
          const stored = await operations.receipts.put({
            scopeId: actor.scopeId,
            clientRequestId: request.clientRequestId,
            commandName: request.command.type,
            requestHash,
            result: committed,
            createdAt: deps.clock.now(),
          })
          if (!stored) {
            raced = true
            refuse("conflict", `Client request ${request.clientRequestId} is already committing`)
          }
          return committed
        })
        .catch(async (cause: unknown) => {
          if (raced) return undefined
          if (cause instanceof TasksStoreConflict) {
            if (cause.kind === "duplicate-receipt") return undefined
            refuse("conflict", cause.message)
          }
          // A store that answers reads from committed rows can let a duplicate
          // past the receipt read and then move the revision under it before
          // the command reads the task. The mutation it asked for is the one
          // that committed, so the refusal is its own earlier commit rather
          // than a competitor and the receipt answers it.
          if (cause instanceof TasksError && cause.detail.code === "stale_revision" && (await committedAlready())) {
            return undefined
          }
          throw cause
        })
      if (result === undefined) return replay(actor, request, requestHash)
      return { result, replayed: false }
    },
  }
}
