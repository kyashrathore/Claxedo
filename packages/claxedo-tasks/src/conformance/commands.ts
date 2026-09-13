/**
 * Runner-neutral replay cases for `createTasksCommands` over a real store.
 *
 * A command receipt is only worth what it answers under contention: two
 * clients holding one `clientRequestId` must commit the mutation once and both
 * be told what committed — whether the adapter arbitrates units in a queue, so
 * the duplicate opens only after the first one's revision has moved, or
 * discovers the collision when its batch lands. Neither answer is visible to
 * the store-port suite next door, because it is assembled here from what the
 * adapter reports. Every host adapter registers these too.
 */
import { createTasksCommands, type TasksCommands } from "../commands"
import type { Task, TasksActor, TasksCommand, TasksCommandRequest, TasksCommandResponse } from "../contracts"
import { TasksError } from "../errors"
import type { TasksStoreOperations, TasksStorePort } from "../ports/store"
import { gate, settle } from "../test-support/concurrency"
import { OWNER, SCOPES } from "../test-support/rows"
import { assert, assertEqual, type TasksStoreConformanceCase, type TasksStoreConformanceFactory } from "./store"

const ACTOR: TasksActor = { scopeId: SCOPES.first, ownerId: OWNER }
const PROJECT = "project-alpha"

const UNREACHED = "a task command reached a port only Start uses"

/**
 * Commands over the adapter under test, with only the ports a task command
 * touches answered. Preset capabilities and the session bridge belong to
 * Start, which no case here runs, so a call into either is a defect in the
 * case rather than a fixture to fill in.
 */
function commandsOver(store: TasksStorePort): TasksCommands {
  let minted = 0
  return createTasksCommands({
    store,
    clock: { now: () => 5_000 },
    ids: {
      presetId: () => `preset-${(minted += 1)}`,
      taskId: () => `task-${(minted += 1)}`,
    },
    capabilities: {
      describe: () => Promise.reject(new Error(UNREACHED)),
      harness: () => Promise.reject(new Error(UNREACHED)),
    },
    authorization: {
      authorizeProject: async () => true,
      authorizeSessionOpen: async () => true,
    },
    bridge: {
      sessionState: () => Promise.reject(new Error(UNREACHED)),
      preview: () => Promise.reject(new Error(UNREACHED)),
      start: () => Promise.reject(new Error(UNREACHED)),
      handoff: () => Promise.reject(new Error(UNREACHED)),
      abandon: () => Promise.reject(new Error(UNREACHED)),
    },
  })
}

const CREATE: TasksCommand = {
  type: "task.create",
  input: { projectId: PROJECT, title: "Replayed task", description: "", workspaceId: null, parentTaskId: null },
}

function request(clientRequestId: string, command: TasksCommand): TasksCommandRequest {
  return { clientRequestId, command }
}

function editCommand(task: Task, title: string): TasksCommand {
  return {
    type: "task.edit",
    input: { taskId: task.id, revision: task.revision, title, description: "", workspaceId: null },
  }
}

function statusCommand(task: Task): TasksCommand {
  return { type: "task.set_status", input: { taskId: task.id, revision: task.revision, status: "doing" } }
}

function archiveCommand(task: Task): TasksCommand {
  return { type: "task.archive", input: { taskId: task.id, revision: task.revision } }
}

/**
 * A store that announces the moment a unit is asked for, before the adapter
 * admits it. The duplicate's own request for a unit is what the request it
 * duplicates waits for, so whatever the duplicate does before asking — a
 * receipt read outside the unit, say — happens while the other one is still
 * uncommitted.
 */
function askingForUnits(store: TasksStorePort, asked: () => void): TasksStorePort {
  return {
    ...store,
    transaction: (work) => {
      asked()
      return store.transaction(work)
    },
  }
}

/** A store whose units all wait for `until`, holding one request mid-flight. */
function holdingUnitsUntil(store: TasksStorePort, until: Promise<void>): TasksStorePort {
  return {
    ...store,
    transaction: (work) =>
      store.transaction(async (operations) => {
        await until
        return work(operations)
      }),
  }
}

/**
 * One store whose task reads inside a unit wait until `clientRequestId` has a
 * committed receipt, so a duplicate that got past the receipt read inside its
 * own unit reads the task only after the request it duplicates has moved the
 * revision. An adapter that arbitrates units never reaches the wait: its
 * duplicate opens after that commit and the receipt read answers it.
 */
function readingTasksAfter(store: TasksStorePort, clientRequestId: string): TasksStorePort {
  const committed = async () => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (await store.receipts.get(ACTOR.scopeId, clientRequestId)) return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error(`Client request ${clientRequestId} never committed, so the duplicate had nothing to replay`)
  }
  const waiting = (operations: TasksStoreOperations): TasksStoreOperations => ({
    ...operations,
    tasks: {
      ...operations.tasks,
      get: async (scopeId, taskId) => {
        await committed()
        return operations.tasks.get(scopeId, taskId)
      },
    },
  })
  return { ...store, transaction: (work) => store.transaction((operations) => work(waiting(operations))) }
}

function mutatedTask(response: TasksCommandResponse): Task {
  const result = response.result
  if (!("task" in result)) throw new Error(`The ${result.type} result carries no task`)
  return result.task
}

function answerOf(outcome: { value: TasksCommandResponse } | { failure: unknown }): TasksCommandResponse {
  if ("failure" in outcome) throw outcome.failure
  return outcome.value
}

function assertSameResult(left: TasksCommandResponse, right: TasksCommandResponse, message: string): void {
  assertEqual(JSON.stringify(left.result), JSON.stringify(right.result), message)
}

/**
 * Two requests that are the same command under the same id, both in flight.
 * What the adapter decides is one commit and one replay of it; which of the
 * two lost is the adapter's business.
 */
function assertOneCommitAndOneReplay(
  first: TasksCommandResponse,
  second: TasksCommandResponse,
  expectedRevision: number,
): void {
  const answers = [first, second]
  assertEqual(answers.filter((answer) => answer.replayed).length, 1, "the duplicate was not answered from the committed receipt")
  assertEqual(answers.filter((answer) => !answer.replayed).length, 1, "the command committed more than once")
  assertSameResult(first, second, "the replay answered a different result")
  assertEqual(mutatedTask(first).revision, expectedRevision, "the duplicate moved the revision a second time")
}

export function tasksCommandReplayConformance(factory: TasksStoreConformanceFactory): readonly TasksStoreConformanceCase[] {
  const start = async () => {
    const { store } = await factory()
    const commands = commandsOver(store)
    const created = await commands.execute(ACTOR, request("request-create", CREATE))
    return { store, commands, task: mutatedTask(created) }
  }

  /**
   * Both requests in flight, with neither committed when the second asks for
   * its unit. On an adapter that queues units the one admitted second then
   * meets a revision the first one has already moved, which is the collision
   * the receipt has to answer.
   */
  const together = async (command: (task: Task) => TasksCommand, expectedRevision: number) => {
    const { store, task } = await start()
    const asked = gate()
    const first = settle(
      commandsOver(holdingUnitsUntil(store, asked.opened)).execute(ACTOR, request("request-duplicate", command(task))),
    )
    const second = settle(
      commandsOver(askingForUnits(store, asked.open)).execute(ACTOR, request("request-duplicate", command(task))),
    )

    assertOneCommitAndOneReplay(answerOf(await first), answerOf(await second), expectedRevision)
    assertEqual((await store.tasks.get(ACTOR.scopeId, task.id))?.revision, expectedRevision, "the stored task is at neither one commit")
  }

  const afterwards = async (command: (task: Task) => TasksCommand, expectedRevision: number) => {
    const { store, commands, task } = await start()
    const committed = await commands.execute(ACTOR, request("request-duplicate", command(task)))
    const again = await commands.execute(ACTOR, request("request-duplicate", command(task)))

    assertEqual(committed.replayed, false, "the first request of a fresh id was answered as a replay")
    assertEqual(again.replayed, true, "the identical request ran again instead of replaying")
    assertSameResult(committed, again, "the replay answered a different result")
    assertEqual((await store.tasks.get(ACTOR.scopeId, task.id))?.revision, expectedRevision, "the identical request committed twice")
  }

  return [
    { name: "identical edits in flight together commit once and the loser replays", run: () => together((task) => editCommand(task, "Edited"), 2) },
    { name: "an identical edit after the first one committed replays it", run: () => afterwards((task) => editCommand(task, "Edited"), 2) },
    { name: "identical status changes in flight together commit once and the loser replays", run: () => together(statusCommand, 2) },
    { name: "an identical status change after the first one committed replays it", run: () => afterwards(statusCommand, 2) },
    { name: "identical archives in flight together commit once and the loser replays", run: () => together(archiveCommand, 2) },
    { name: "an identical archive after the first one committed replays it", run: () => afterwards(archiveCommand, 2) },

    {
      name: "a duplicate that reads the task after the commit replays instead of refusing",
      run: async () => {
        const { store, task } = await start()
        const asked = gate()
        const command = editCommand(task, "Edited")
        const first = settle(
          commandsOver(askingForUnits(store, asked.open)).execute(ACTOR, request("request-duplicate", command)),
        )
        // The duplicate asks for its unit second, so a queue admits it after
        // the commit it waits for instead of ahead of it.
        await asked.opened
        const second = settle(
          commandsOver(readingTasksAfter(store, "request-duplicate")).execute(ACTOR, request("request-duplicate", command)),
        )

        assertOneCommitAndOneReplay(answerOf(await first), answerOf(await second), 2)
      },
    },

    {
      name: "another command under a committed request id is refused",
      run: async () => {
        const { store, commands, task } = await start()
        await commands.execute(ACTOR, request("request-duplicate", editCommand(task, "Edited")))

        const refused = await settle(commands.execute(ACTOR, request("request-duplicate", editCommand(task, "Something else"))))
        assert("failure" in refused, "a different command under a committed request id was answered instead of refused")
        const failure = refused.failure
        assert(failure instanceof TasksError, `the refusal is not a Tasks refusal: ${String(failure)}`)
        assertEqual(failure.detail.code, "conflict", "a different command under a committed request id was not refused as a conflict")
        assertEqual((await store.tasks.get(ACTOR.scopeId, task.id))?.title, "Edited", "the refused command wrote through")
      },
    },
  ]
}
