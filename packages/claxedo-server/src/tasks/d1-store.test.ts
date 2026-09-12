/**
 * D1 side of the shared Tasks store-port conformance suite, plus the three
 * properties only this adapter has to prove: that a unit of work really does
 * commit as one batch; that a row which moved between the read that decided a
 * write and the batch that carries it takes the whole batch down instead of
 * committing a lost update; and that such a refused batch reaches the caller as
 * the conflict it was, which is what lets a duplicate command replay and a
 * losing edit answer 409.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import { tasksStoreConformance, CONFORMANCE_SCOPES } from "@claxedo/tasks/conformance"
import {
  TasksError,
  TasksStoreConflict,
  createTasksCommands,
  type Task,
  type TaskSessionLink,
  type TasksActor,
  type TasksAuthorizationPort,
  type TasksCapabilitiesPort,
  type TasksCommandRequest,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"

import { createD1TasksStore } from "./d1-store"

// 0024 owns every table under test and references no auth table, so it is the
// only migration this store needs. The real file runs — a hand-written schema
// here would prove the store works against a table that does not ship.
const MIGRATIONS = ["0024_claxedo_tasks.sql"]

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

function taskRow(input: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scopeId: input.scopeId ?? CONFORMANCE_SCOPES.first,
    projectId: input.projectId ?? "project-alpha",
    workspaceId: input.workspaceId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    title: input.title ?? "Guarded task",
    description: input.description ?? "",
    status: input.status ?? "todo",
    childSetRevision: input.childSetRevision ?? 0,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  }
}

const DIGEST = "d".repeat(64)

function linkRow(sessionId: string): TaskSessionLink {
  return {
    scopeId: CONFORMANCE_SCOPES.first,
    taskId: "task-linked",
    slot: "primary",
    attempt: 1,
    sessionRef: { sessionId, workspaceId: null },
    continuedFrom: null,
    presetId: "preset-linked",
    presetRevision: 1,
    presetNameAtStart: "Linked preset",
    configurationDigest: DIGEST,
    createdAt: 2_000,
  }
}

const ACTOR: TasksActor = { scopeId: CONFORMANCE_SCOPES.first, ownerId: "owner-a" }

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
  }
  return createTasksCommands({
    store: createD1TasksStore({ database }),
    clock: { now: () => 4_000 },
    ids: {
      presetId: () => `preset-${(minted += 1)}`,
      taskId: () => `task-${(minted += 1)}`,
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
        .bind(CONFORMANCE_SCOPES.first, "task-guarded")
        .run()
    })

    await expect(refused).rejects.toThrow()
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-guarded")).toMatchObject({ revision: 7, title: "Theirs" })
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-child")).toBeUndefined()
    const guards = await target.prepare("select count(*) as rows from task_write_guards").first<{ rows: number }>()
    expect(guards?.rows).toBe(0)
  })

  test("a unit reads the rows it has written but not yet committed", async () => {
    const store = createD1TasksStore({ database: await database() })
    await store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-pending", revision: 1 }))
      expect(await tx.tasks.get(CONFORMANCE_SCOPES.first, "task-pending")).toMatchObject({ id: "task-pending" })
      expect(await tx.tasks.update(taskRow({ id: "task-pending", revision: 2, title: "Renamed" }), 1)).toBe(true)
    })
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-pending")).toMatchObject({ revision: 2, title: "Renamed" })
  })

  test("a list read after a write inside one unit is refused rather than answered from committed rows", async () => {
    const store = createD1TasksStore({ database: await database() })
    const refused = store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-listed", parentTaskId: "task-parent" }))
      await tx.tasks.countChildren(CONFORMANCE_SCOPES.first, "task-parent", { includeArchived: true, excludeStatus: null })
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
        .bind(CONFORMANCE_SCOPES.first, "task-contended")
        .run()
    })

    await expect(refused).rejects.toThrow(TasksStoreConflict)
    await expect(refused).rejects.toMatchObject({ kind: "stale-revision" })
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-contended")).toMatchObject({ revision: 9, title: "Theirs" })
  })

  test("a session origin claimed under a committing unit reaches the caller as a link conflict", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })

    const refused = store.transaction(async (tx) => {
      expect((await tx.links.insert(linkRow("session-mine"))).status).toBe("inserted")
      await target
        .prepare(
          `insert into task_session_links (scope_id, task_id, slot, attempt, session_id, preset_id, preset_revision, preset_name_at_start, configuration_digest, created_at)` +
            ` values (?, 'task-linked', 'primary', 1, 'session-theirs', 'preset-linked', 1, 'Linked preset', ?, 2000)`,
        )
        .bind(CONFORMANCE_SCOPES.first, DIGEST)
        .run()
    })

    await expect(refused).rejects.toMatchObject({ kind: "link-conflict" })
    expect((await store.links.getCurrent(CONFORMANCE_SCOPES.first, "task-linked", "primary"))?.sessionRef.sessionId).toBe(
      "session-theirs",
    )
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
