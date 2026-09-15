/**
 * D1 side of the shared Tasks store-port conformance suite, plus the three
 * properties only this adapter has to prove: that a unit of work really does
 * commit as one batch; that a row which moved between the read that decided a
 * write and the batch that carries it takes the whole batch down instead of
 * committing a lost update; and that such a refused batch reaches the caller as
 * the conflict it was, which is what lets a duplicate command replay and a
 * losing edit answer 409.
 */
import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"

import { tasksStoreConformance, tasksCommandReplayConformance } from "@claxedo/tasks/conformance"
import { linkRow, taskRow, SCOPES } from "@claxedo/tasks/test-support"
import {
  TasksError,
  TasksStoreConflict,
  createTasksCommands,
  type TaskSessionLink,
  type TasksActor,
  type TasksAuthorizationPort,
  type TasksCapabilitiesPort,
  type TasksCommandRequest,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"

import {
  applyControlPlaneMigration,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../test-support/control-plane-migrations"
import { createD1TasksStore } from "./d1-store"

// 0025 and 0026 own every table under test and reference no auth table, so
// they are the only migrations this store needs.
const MIGRATIONS = [
  "0025_claxedo_tasks.sql",
  "0026_agent_cross_machine_writes.sql",
  "0032_task_attachments.sql",
  "0033_task_child_number.sql",
]

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(migrations: readonly string[] = MIGRATIONS): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(migrations)
  active.push(instance)
  return instance.database
}

const DIGEST = "d".repeat(64)

function linkedSession(sessionId: string): TaskSessionLink {
  return linkRow({
    taskId: "task-linked",
    attempt: 1,
    sessionRef: { sessionId, workspaceId: null },
    presetId: "preset-linked",
    presetNameAtStart: "Linked preset",
    configurationDigest: DIGEST,
  })
}

const ACTOR: TasksActor = { scopeId: SCOPES.first, ownerId: "owner-a" }

const UNREACHABLE = "the bridge is not reached by a task command"

/**
 * Commands over the real D1 adapter, with only the ports a task command
 * touches answered. Preset capabilities and the session bridge belong to Start,
 * which no case here runs; a call into either is a defect in the case, not a
 * fixture to fill in.
 */
function commandsOver(database: D1Database) {
  let minted = 0
  const authorization: TasksAuthorizationPort = {
    authorizeProject: async () => true,
    authorizeSessionOpen: async () => true,
  }
  const capabilities: TasksCapabilitiesPort = {
    describe: () => Promise.reject(new Error(UNREACHABLE)),
    harness: () => Promise.reject(new Error(UNREACHABLE)),
  }
  const bridge: TasksSessionBridgePort = {
    sessionState: () => Promise.reject(new Error(UNREACHABLE)),
    preview: () => Promise.reject(new Error(UNREACHABLE)),
    start: () => Promise.reject(new Error(UNREACHABLE)),
    handoff: () => Promise.reject(new Error(UNREACHABLE)),
    abandon: () => Promise.reject(new Error(UNREACHABLE)),
  }
  return createTasksCommands({
    store: createD1TasksStore({ database }),
    clock: { now: () => 4_000 },
    ids: {
      presetId: () => `preset-${(minted += 1)}`,
      taskId: () => `task-${(minted += 1)}`,
      attachmentId: () => `attachment-${(minted += 1)}`,
    },
    capabilities,
    authorization,
    bridge,
  })
}

const createRequest: TasksCommandRequest = {
  clientRequestId: "request-raced",
  command: {
    type: "task.create",
    input: { projectId: "project-alpha", title: "Raced", description: "", workspaceId: null, parentTaskId: null },
  },
}

describe("D1 TasksStorePort conformance", () => {
  for (const testCase of tasksStoreConformance(async () => ({ store: createD1TasksStore({ database: await database() }) }))) {
    test(testCase.name, testCase.run)
  }
})

describe("D1 Tasks command replay conformance", () => {
  for (const testCase of tasksCommandReplayConformance(async () => ({
    store: createD1TasksStore({ database: await database() }),
  }))) {
    test(testCase.name, testCase.run)
  }
})

describe("D1 Tasks store units", () => {
  test("a revision that moves between the read and the batch takes the whole batch down", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })
    await store.tasks.insert(taskRow({ id: "task-guarded", revision: 1 }))

    const refused = store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-child", parentTaskId: "task-guarded" }))
      expect(await tx.tasks.update(taskRow({ id: "task-guarded", revision: 2, title: "Mine" }), 1)).toBe(true)
      // Another writer commits between this unit's read and its batch.
      await target
        .prepare("update tasks set revision = 7, title = 'Theirs' where scope_id = ? and task_id = ?")
        .bind(SCOPES.first, "task-guarded")
        .run()
    })

    await expect(refused).rejects.toThrow()
    expect(await store.tasks.get(SCOPES.first, "task-guarded")).toMatchObject({ revision: 7, title: "Theirs" })
    expect(await store.tasks.get(SCOPES.first, "task-child")).toBeUndefined()
    const guards = await target.prepare("select count(*) as rows from task_write_guards").first<{ rows: number }>()
    expect(guards?.rows).toBe(0)
  })

  test("a preset revision asserted by a unit that writes nothing else still refuses the batch when it moves", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })
    await target
      .prepare(
        "insert into task_presets (scope_id, preset_id, revision, owner_id, name, instructions, execution, configurations," +
          " archived_at, created_at, updated_at) values (?, ?, 1, 'owner-a', 'Pinned', '', '{}', '{}', null, 1, 1)",
      )
      .bind(SCOPES.first, "preset-pinned")
      .run()

    const refused = store.transaction(async (tx) => {
      expect(await tx.presets.assertRevision(SCOPES.first, "preset-pinned", 1)).toBe(true)
      await tx.links.insert(linkedSession("session-settling"))
      // Another writer commits between this unit's assertion and its batch.
      await target
        .prepare("update task_presets set revision = 2 where scope_id = ? and preset_id = ?")
        .bind(SCOPES.first, "preset-pinned")
        .run()
    })

    await expect(refused).rejects.toThrow(TasksStoreConflict)
    expect(await store.links.getCurrent(SCOPES.first, "task-linked", "primary")).toBeUndefined()
    const guards = await target.prepare("select count(*) as rows from task_write_guards").first<{ rows: number }>()
    expect(guards?.rows).toBe(0)
  })

  test("an assertion that holds is no write of its own", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })
    await target
      .prepare(
        "insert into task_presets (scope_id, preset_id, revision, owner_id, name, instructions, execution, configurations," +
          " archived_at, created_at, updated_at) values (?, ?, 1, 'owner-a', 'Pinned', '', '{}', '{}', null, 1, 1)",
      )
      .bind(SCOPES.first, "preset-pinned")
      .run()

    await store.transaction(async (tx) => {
      expect(await tx.presets.assertRevision(SCOPES.first, "preset-pinned", 1)).toBe(true)
      // The list read refuses inside a unit that has written rows, so it is
      // also the check that the assertion wrote none.
      expect((await tx.links.listByTask(SCOPES.first, "task-linked")).length).toBe(0)
    })
    const stored = await target
      .prepare("select revision from task_presets where scope_id = ? and preset_id = ?")
      .bind(SCOPES.first, "preset-pinned")
      .first<{ revision: number }>()
    expect(stored?.revision).toBe(1)
  })

  test("a unit reads the rows it has written but not yet committed", async () => {
    const store = createD1TasksStore({ database: await database() })
    await store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-pending", revision: 1 }))
      expect(await tx.tasks.get(SCOPES.first, "task-pending")).toMatchObject({ id: "task-pending" })
      expect(await tx.tasks.update(taskRow({ id: "task-pending", revision: 2, title: "Renamed" }), 1)).toBe(true)
    })
    expect(await store.tasks.get(SCOPES.first, "task-pending")).toMatchObject({ revision: 2, title: "Renamed" })
  })

  test("a list read after a write inside one unit is refused rather than answered from committed rows", async () => {
    const store = createD1TasksStore({ database: await database() })
    const refused = store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-listed", parentTaskId: "task-parent" }))
      await tx.tasks.countChildren(SCOPES.first, "task-parent", { includeArchived: true, excludeStatus: null })
    })
    await expect(refused).rejects.toThrow(/already written rows/)
  })

  test("a revision that moves under a committing unit reaches the caller as a stale-revision conflict", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })
    await store.tasks.insert(taskRow({ id: "task-contended", revision: 1 }))

    const refused = store.transaction(async (tx) => {
      expect(await tx.tasks.update(taskRow({ id: "task-contended", revision: 2, title: "Mine" }), 1)).toBe(true)
      await target
        .prepare("update tasks set revision = 9, title = 'Theirs' where scope_id = ? and task_id = ?")
        .bind(SCOPES.first, "task-contended")
        .run()
    })

    await expect(refused).rejects.toThrow(TasksStoreConflict)
    await expect(refused).rejects.toMatchObject({ kind: "stale-revision" })
    expect(await store.tasks.get(SCOPES.first, "task-contended")).toMatchObject({ revision: 9, title: "Theirs" })
  })

  test("a session origin claimed under a committing unit reaches the caller as a link conflict", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })

    const refused = store.transaction(async (tx) => {
      expect((await tx.links.insert(linkedSession("session-mine"))).status).toBe("inserted")
      await target
        .prepare(
          `insert into task_session_links (scope_id, task_id, slot, attempt, session_id, preset_id, preset_revision, preset_name_at_start, configuration_digest, created_at)` +
            ` values (?, 'task-linked', 'primary', 1, 'session-theirs', 'preset-linked', 1, 'Linked preset', ?, 2000)`,
        )
        .bind(SCOPES.first, DIGEST)
        .run()
    })

    await expect(refused).rejects.toMatchObject({ kind: "link-conflict" })
    expect((await store.links.getCurrent(SCOPES.first, "task-linked", "primary"))?.sessionRef.sessionId).toBe(
      "session-theirs",
    )
  })

  test("a reparent that lands on a child number another child took is a number-taken conflict, in and out of a unit", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })
    const parent = taskRow({ id: "task-parent" })
    await store.tasks.insert(parent)
    await store.tasks.insert(taskRow({ id: "task-first", number: parent.number, childNumber: 1, parentTaskId: parent.id }))
    const loose = taskRow({ id: "task-loose" })
    await store.tasks.insert(loose)
    const filed = { ...loose, revision: 2, number: parent.number, childNumber: 1, parentTaskId: parent.id }
    const conflict = {
      name: "TasksStoreConflict",
      kind: "number-taken",
      message: expect.stringContaining(`task number ${parent.number}.1`),
    }

    await expect(store.tasks.update(filed, loose.revision)).rejects.toMatchObject(conflict)
    await expect(store.transaction((tx) => tx.tasks.update(filed, loose.revision))).rejects.toMatchObject(conflict)
    expect(await store.tasks.get(SCOPES.first, "task-loose")).toMatchObject({ revision: 1, parentTaskId: null })
  })
})

describe("D1 Tasks child-number migration", () => {
  test("subtasks take their parent's number and a child number in creation order; roots keep theirs", async () => {
    const target = await database(MIGRATIONS.filter((name) => name !== "0033_task_child_number.sql"))
    const insert = (id: string, number: number, parent: string | null, createdAt: number) =>
      target
        .prepare(
          `insert into tasks (scope_id, task_id, revision, project_id, number, workspace_id, parent_task_id, title, description, status, child_set_revision, archived_at, created_at, updated_at)` +
            ` values (?, ?, 1, 'project-a', ?, null, ?, ?, '', 'todo', 0, null, ?, ?)`,
        )
        .bind(SCOPES.first, id, number, parent, id, createdAt, createdAt)
        .run()
    await insert("root-20", 20, null, 1)
    await insert("root-21", 21, null, 2)
    await insert("child-late", 23, "root-20", 4)
    await insert("child-early", 22, "root-20", 3)
    await insert("child-other", 24, "root-21", 5)
    await insert("root-1", 1, null, 6)

    await applyControlPlaneMigration(target, "0033_task_child_number.sql")

    const store = createD1TasksStore({ database: target })
    const filed = async (id: string) => {
      const task = await store.tasks.get(SCOPES.first, id)
      return `${task?.number}${task?.childNumber === null ? "" : `.${task?.childNumber}`}`
    }
    expect(await filed("root-20")).toBe("20")
    expect(await filed("root-21")).toBe("21")
    expect(await filed("root-1")).toBe("1")
    expect(await filed("child-early")).toBe("20.1")
    expect(await filed("child-late")).toBe("20.2")
    expect(await filed("child-other")).toBe("21.1")
    expect(await store.tasks.nextChildNumber(SCOPES.first, "root-20")).toBe(3)
    expect(await store.tasks.nextNumber(SCOPES.first, "project-a")).toBe(22)
  })
})

describe("D1 Tasks commands", () => {
  test("two identical requests commit once and the loser replays the committed result", async () => {
    const commands = commandsOver(await database())

    const settled = await Promise.allSettled([commands.execute(ACTOR, createRequest), commands.execute(ACTOR, createRequest)])
    const answers = settled.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason
      return outcome.value
    })

    expect(answers.filter((answer) => answer.replayed)).toHaveLength(1)
    expect(answers[0]?.result).toEqual(answers[1]?.result)
  })

  test("the request that loses a revision to a competitor is refused as a conflict", async () => {
    const target = await database()
    const commands = commandsOver(target)
    const created = await commands.execute(ACTOR, createRequest)
    if (created.result.type !== "task.create") throw new Error("the fixture did not create a task")
    const task = created.result.task

    const edit = (clientRequestId: string, title: string): TasksCommandRequest => ({
      clientRequestId,
      command: {
        type: "task.edit",
        input: { taskId: task.id, revision: task.revision, title, description: "", workspaceId: null },
      },
    })

    const settled = await Promise.allSettled([commands.execute(ACTOR, edit("request-a", "A")), commands.execute(ACTOR, edit("request-b", "B"))])
    const refusals = settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toBeInstanceOf(TasksError)
    expect(refusals[0]).toMatchObject({ detail: { code: "conflict" } })
  })
})
