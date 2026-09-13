/**
 * Runner-neutral conformance cases for `TasksStorePort`.
 *
 * Four invariants carry this kit and none of them can be checked by reading
 * an adapter: a revision predicate that misses must write nothing AND take the
 * command receipt in its transaction down with it; the origin
 * `(scopeId, taskId, slot, attempt)` must be claimable exactly once so two
 * clients converge on one session instead of each getting their own; a scope
 * must be a wall, not a filter someone forgot in one query; and two units that
 * overlap must be arbitrated, so a rollback cannot erase a commit and one row
 * cannot be bumped twice from one revision. Each host adapter — memory here,
 * SQLite and D1 elsewhere — registers these with its own runner.
 */
import type { ConfigurationSlot, Preset, Task, TaskSessionLink } from "../contracts"
import { TasksStoreConflict, type TasksCommandReceipt, type TasksStorePort } from "../ports/store"

export const TASKS_STORE_CONFORMANCE_VERSION = 4 as const

export const TASKS_STORE_CONFORMANCE_SCOPE = {
  cases: [
    "a_failed_revision_predicate_rolls_the_whole_unit_back",
    "a_zero_row_update_cannot_leave_a_receipt_behind",
    "a_parent_and_its_child_commit_together",
    "a_second_link_for_one_origin_converges_on_the_stored_session",
    "a_second_link_naming_another_session_is_reported_as_a_conflict",
    "attempts_are_unique_and_the_highest_one_is_current",
    "a_receipt_is_written_once_and_replays_its_result",
    "pagination_is_stable_across_pages",
    "another_scope_can_neither_read_nor_mutate",
    "a_rolled_back_unit_leaves_the_unit_that_committed_beside_it_intact",
    "overlapping_units_cannot_both_bump_one_row_from_the_same_revision",
    "a_preset_revision_assertion_is_a_predicate_of_the_unit_that_made_it",
    "a_list_row_counts_its_own_links_and_only_this_scope_s",
  ],
  // NOT pinned:
  //
  //   `list_ordering_beyond_the_page_key` — every case compares id sequences
  //   produced by the port's own cursor, never a secondary sort an adapter
  //   might add.
  //
  // Which of two overlapping units wins IS pinned, but only as "exactly one of
  // them": the two arbitration cases name what may not happen — a rollback
  // erasing a committed unit, two units bumping one row from one revision —
  // and leave the winner to the adapter, because a queue and an optimistic
  // batch order them differently and both are correct.
  remaining: ["list_ordering_beyond_the_page_key"],
} as const

export type TasksStoreConformanceFactory = () => Promise<Readonly<{ store: TasksStorePort }>>

export type TasksStoreConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

export const CONFORMANCE_SCOPES = {
  first: "conformance-scope-alpha",
  second: "conformance-scope-beta",
} as const

const OWNER = "conformance-owner"

function preset(input: Partial<Preset> & Pick<Preset, "id">): Preset {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scopeId: input.scopeId ?? CONFORMANCE_SCOPES.first,
    ownerId: input.ownerId ?? OWNER,
    name: input.name ?? "Conformance preset",
    instructions: input.instructions ?? "",
    execution: input.execution ?? { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: input.configurations ?? {
      primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "sonnet" }, effort: null },
    },
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  }
}

function taskRow(input: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scopeId: input.scopeId ?? CONFORMANCE_SCOPES.first,
    projectId: input.projectId ?? "project-alpha",
    workspaceId: input.workspaceId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    title: input.title ?? "Conformance task",
    description: input.description ?? "",
    status: input.status ?? "todo",
    childSetRevision: input.childSetRevision ?? 0,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  }
}

function linkRow(input: Partial<TaskSessionLink> & Pick<TaskSessionLink, "taskId" | "attempt">): TaskSessionLink {
  const slot: ConfigurationSlot = input.slot ?? "primary"
  return {
    scopeId: input.scopeId ?? CONFORMANCE_SCOPES.first,
    taskId: input.taskId,
    slot,
    attempt: input.attempt,
    sessionRef: input.sessionRef ?? { sessionId: `session-${input.taskId}-${slot}-${input.attempt}`, workspaceId: null },
    continuedFrom: input.continuedFrom ?? null,
    presetId: input.presetId ?? "preset-conformance",
    presetRevision: input.presetRevision ?? 1,
    presetNameAtStart: input.presetNameAtStart ?? "Conformance preset",
    configurationDigest: input.configurationDigest ?? "c".repeat(64),
    handoffText: input.handoffText ?? null,
    createdAt: input.createdAt ?? 2_000,
  }
}

function receipt(input: Partial<TasksCommandReceipt> & Pick<TasksCommandReceipt, "clientRequestId" | "result">): TasksCommandReceipt {
  return {
    scopeId: input.scopeId ?? CONFORMANCE_SCOPES.first,
    clientRequestId: input.clientRequestId,
    commandName: input.commandName ?? "task.create",
    requestHash: input.requestHash ?? "hash-a",
    result: input.result,
    createdAt: input.createdAt ?? 3_000,
  }
}

const LIST = { cursor: null, limit: 50, includeArchived: false } as const
const TASK_LIST = { ...LIST, projectId: "project-alpha", status: null, parent: "any" } as const

class ConformanceRollback extends Error {}

/** A promise the case resolves itself, to hold one unit open while it opens a second. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/**
 * A unit's outcome as a value. Awaiting two overlapping units in order would
 * report the second one's rejection as unhandled while the first is still in
 * flight, so each is turned into a value the moment it is started.
 */
export function settle<T>(unit: Promise<T>): Promise<{ value: T } | { failure: unknown }> {
  return unit.then(
    (value) => ({ value }),
    (failure: unknown) => ({ failure }),
  )
}

/**
 * Whether a unit's compare-and-set won. A store that decides the predicate
 * inline answers false; one that decides it at commit answers true and then
 * rejects the unit with a stale-revision conflict. Both are refusals.
 */
function wonTheBump(outcome: { value: boolean } | { failure: unknown }): boolean {
  if ("value" in outcome) return outcome.value
  if (outcome.failure instanceof TasksStoreConflict && outcome.failure.kind === "stale-revision") return false
  throw outcome.failure
}

export function tasksStoreConformance(factory: TasksStoreConformanceFactory): readonly TasksStoreConformanceCase[] {
  const start = async () => {
    const { store } = await factory()
    const presets = await store.presets.list(CONFORMANCE_SCOPES.first, OWNER, LIST)
    const tasks = await store.tasks.list(CONFORMANCE_SCOPES.first, TASK_LIST)
    assertEqual(presets.items.length, 0, "Conformance factory must yield a store with no presets")
    assertEqual(tasks.items.length, 0, "Conformance factory must yield a store with no tasks")
    return store
  }

  const rollback = async (store: TasksStorePort, work: Parameters<TasksStorePort["transaction"]>[0]) => {
    let refused = false
    try {
      await store.transaction(work)
    } catch (cause) {
      if (!(cause instanceof ConformanceRollback)) throw cause
      refused = true
    }
    assert(refused, "The transaction committed although its work threw")
  }

  return [
    conformanceCase("a failed revision predicate rolls the whole unit back", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-anchor", revision: 4 }))

      await rollback(store, async (tx) => {
        await tx.tasks.insert(taskRow({ id: "task-written-first" }))
        const stale = await tx.tasks.update(taskRow({ id: "task-anchor", revision: 5, title: "Rewritten" }), 3)
        assertEqual(stale, false, "update reported success for a revision no row was at")
        throw new ConformanceRollback("stale revision")
      })

      assertEqual(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-written-first"), undefined, "the rolled-back unit kept its insert")
      const anchor = await store.tasks.get(CONFORMANCE_SCOPES.first, "task-anchor")
      assertEqual(anchor?.revision, 4, "the refused update moved the row it could not match")
      assertEqual(anchor?.title, "Conformance task", "the refused update rewrote the row")
    }),

    conformanceCase("a zero-row update cannot leave a receipt behind", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-receipted", revision: 2 }))

      await rollback(store, async (tx) => {
        const written = await tx.receipts.put(
          receipt({ clientRequestId: "request-doomed", result: { type: "task.archive", task: taskRow({ id: "task-receipted" }), parent: null } }),
        )
        assertEqual(written, true, "the receipt was refused before the update was even attempted")
        const stale = await tx.tasks.update(taskRow({ id: "task-receipted", revision: 3 }), 1)
        assertEqual(stale, false, "update reported success for a revision no row was at")
        throw new ConformanceRollback("stale revision")
      })

      assertEqual(
        await store.receipts.get(CONFORMANCE_SCOPES.first, "request-doomed"),
        undefined,
        "a receipt survived the transaction whose mutation never committed",
      )
    }),

    conformanceCase("a parent and its child commit together", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-parent", revision: 1 }))

      await rollback(store, async (tx) => {
        await tx.tasks.insert(taskRow({ id: "task-child-lost", parentTaskId: "task-parent" }))
        await tx.tasks.update(taskRow({ id: "task-parent", revision: 2, childSetRevision: 1 }), 1)
        throw new ConformanceRollback("a later guard refused")
      })

      assertEqual(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-child-lost"), undefined, "the child outlived its unit")
      assertEqual((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-parent"))?.childSetRevision, 0, "the parent kept a bump its child never got")

      await store.transaction(async (tx) => {
        await tx.tasks.insert(taskRow({ id: "task-child-kept", parentTaskId: "task-parent" }))
        assertEqual(
          await tx.tasks.update(taskRow({ id: "task-parent", revision: 2, childSetRevision: 1 }), 1),
          true,
          "the parent update was refused inside its own unit",
        )
      })

      assertEqual((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-child-kept"))?.parentTaskId, "task-parent", "the committed child is missing")
      assertEqual((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-parent"))?.childSetRevision, 1, "the committed parent bump is missing")
      assertEqual(
        await store.tasks.countChildren(CONFORMANCE_SCOPES.first, "task-parent", { includeArchived: true, excludeStatus: null }),
        1,
        "the child set counts a row that was rolled back",
      )
    }),

    conformanceCase("a second link for one origin converges on the stored session", async () => {
      const store = await start()
      const first = linkRow({ taskId: "task-slotted", attempt: 1, sessionRef: { sessionId: "session-one", workspaceId: null } })
      assertEqual((await store.links.insert(first)).status, "inserted", "the first link for an empty origin was refused")

      const again = await store.links.insert(first)
      assertEqual(again.status, "exists", "the origin accepted a second write")
      assert(again.status === "exists" && again.link.sessionRef.sessionId === "session-one", "the occupied origin did not report the session it holds")
      assertEqual((await store.links.getCurrent(CONFORMANCE_SCOPES.first, "task-slotted", "primary"))?.sessionRef.sessionId, "session-one", "the origin moved")
    }),

    conformanceCase("a second link naming another session is reported as a conflict", async () => {
      const store = await start()
      await store.links.insert(linkRow({ taskId: "task-slotted", attempt: 1, sessionRef: { sessionId: "session-one", workspaceId: null } }))

      const other = await store.links.insert(
        linkRow({ taskId: "task-slotted", attempt: 1, sessionRef: { sessionId: "session-two", workspaceId: "workspace-two" } }),
      )
      assertEqual(other.status, "exists", "a competing session claimed an occupied origin")
      assert(
        other.status === "exists" && other.link.sessionRef.sessionId === "session-one",
        "the occupied origin echoed the competing session instead of the one it holds",
      )
      assertEqual(
        (await store.links.getCurrent(CONFORMANCE_SCOPES.first, "task-slotted", "primary"))?.sessionRef.sessionId,
        "session-one",
        "the competing write replaced the stored session",
      )
    }),

    conformanceCase("attempts are unique and the highest one is current", async () => {
      const store = await start()
      await store.links.insert(linkRow({ taskId: "task-slotted", attempt: 1 }))
      await store.links.insert(linkRow({ taskId: "task-slotted", attempt: 2 }))
      await store.links.insert(linkRow({ taskId: "task-slotted", attempt: 1, slot: "review" }))

      const current = await store.links.getCurrent(CONFORMANCE_SCOPES.first, "task-slotted", "primary")
      assertEqual(current?.attempt, 2, "the slot's current link is not its highest attempt")
      assertEqual(
        (await store.links.getCurrent(CONFORMANCE_SCOPES.first, "task-slotted", "review"))?.attempt,
        1,
        "one slot's attempts leaked into another",
      )
      const history = await store.links.listByTask(CONFORMANCE_SCOPES.first, "task-slotted")
      assertEqual(history.length, 3, "an earlier attempt was replaced instead of kept as history")
    }),

    conformanceCase("a receipt is written once and replays its result", async () => {
      const store = await start()
      const committed = receipt({
        clientRequestId: "request-once",
        requestHash: "hash-a",
        result: { type: "task.create", task: taskRow({ id: "task-committed" }), parent: null },
      })
      assertEqual(await store.receipts.put(committed), true, "the first receipt for a fresh request id was refused")
      assertEqual(
        await store.receipts.put(receipt({ clientRequestId: "request-once", requestHash: "hash-b", result: { type: "task.archive", task: taskRow({ id: "task-other" }), parent: null } })),
        false,
        "a second receipt claimed a request id that was already committed",
      )

      const replayed = await store.receipts.get(CONFORMANCE_SCOPES.first, "request-once")
      assertEqual(replayed?.requestHash, "hash-a", "the replayed receipt is not the one that committed")
      assertEqual(replayed?.result.type, "task.create", "the replayed result is not the one that committed")
      assertEqual(
        await store.receipts.get(CONFORMANCE_SCOPES.second, "request-once"),
        undefined,
        "a receipt replayed into another scope",
      )
    }),

    conformanceCase("pagination is stable across pages", async () => {
      const store = await start()
      const written = [
        taskRow({ id: "task-e", createdAt: 1_000 }),
        taskRow({ id: "task-d", createdAt: 1_000 }),
        taskRow({ id: "task-c", createdAt: 2_000 }),
        taskRow({ id: "task-b", createdAt: 2_000 }),
        taskRow({ id: "task-a", createdAt: 3_000 }),
      ]
      for (const row of written) await store.tasks.insert(row)

      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 5; page += 1) {
        const result = await store.tasks.list(CONFORMANCE_SCOPES.first, { ...TASK_LIST, limit: 2, cursor })
        seen.push(...result.items.map((row) => row.id))
        cursor = result.nextCursor
        if (cursor === null) break
      }
      assertEqual(cursor, null, "paging never reached the end of five rows")
      assertEqual(
        seen.join(" "),
        "task-a task-c task-b task-e task-d",
        "pages did not come back newest first with a stable id tie-break",
      )
    }),

    conformanceCase("another scope can neither read nor mutate", async () => {
      const store = await start()
      await store.presets.insert(preset({ id: "preset-alpha" }))
      await store.tasks.insert(taskRow({ id: "task-alpha", revision: 1 }))
      await store.links.insert(linkRow({ taskId: "task-alpha", attempt: 1 }))

      assertEqual(await store.presets.get(CONFORMANCE_SCOPES.second, "preset-alpha"), undefined, "a preset was readable from another scope")
      assertEqual(await store.tasks.get(CONFORMANCE_SCOPES.second, "task-alpha"), undefined, "a task was readable from another scope")
      assertEqual(
        await store.links.getCurrent(CONFORMANCE_SCOPES.second, "task-alpha", "primary"),
        undefined,
        "a link was readable from another scope",
      )
      assertEqual(
        (await store.presets.list(CONFORMANCE_SCOPES.second, OWNER, LIST)).items.length,
        0,
        "a preset listed into another scope",
      )
      assertEqual(
        (await store.tasks.list(CONFORMANCE_SCOPES.second, TASK_LIST)).items.length,
        0,
        "a task listed into another scope",
      )
      assertEqual(
        (await store.links.listByTask(CONFORMANCE_SCOPES.second, "task-alpha")).length,
        0,
        "a link listed into another scope",
      )

      assertEqual(
        await store.tasks.update(taskRow({ id: "task-alpha", scopeId: CONFORMANCE_SCOPES.second, revision: 2, title: "Taken" }), 1),
        false,
        "another scope updated a row it cannot read",
      )
      assertEqual((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-alpha"))?.title, "Conformance task", "the foreign update wrote through")
    }),

    conformanceCase("a rolled back unit leaves the unit that committed beside it intact", async () => {
      const store = await start()
      const held = gate()

      const refused = settle(
        store.transaction(async (tx) => {
          await tx.tasks.insert(taskRow({ id: "task-rolled-back" }))
          await held.opened
          throw new ConformanceRollback("a later guard refused")
        }),
      )
      const committed = settle(
        store.transaction(async (tx) => {
          await tx.tasks.insert(taskRow({ id: "task-committed" }))
        }),
      )
      held.open()

      const refusal = await refused
      assert("failure" in refusal && refusal.failure instanceof ConformanceRollback, "the unit whose work threw committed")
      const other = await committed
      assert("value" in other, `the unit beside it was refused: ${String("failure" in other && other.failure)}`)

      assert(
        (await store.tasks.get(CONFORMANCE_SCOPES.first, "task-committed")) !== undefined,
        "the rollback took a row that another unit had committed",
      )
      assertEqual(
        await store.tasks.get(CONFORMANCE_SCOPES.first, "task-rolled-back"),
        undefined,
        "the rolled-back unit kept its insert",
      )
    }),

    conformanceCase("overlapping units cannot both bump one row from the same revision", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-contended", revision: 1 }))
      const read = await store.tasks.get(CONFORMANCE_SCOPES.first, "task-contended")
      assertEqual(read?.revision, 1, "the row is not at the revision both units are about to read")

      const held = gate()
      const first = settle(
        store.transaction(async (tx) => {
          await held.opened
          return tx.tasks.update(taskRow({ id: "task-contended", revision: 2, title: "First" }), 1)
        }),
      )
      const second = settle(
        store.transaction(async (tx) => tx.tasks.update(taskRow({ id: "task-contended", revision: 2, title: "Second" }), 1)),
      )
      held.open()

      const won = [wonTheBump(await first), wonTheBump(await second)]
      assertEqual(won.filter((bumped) => bumped).length, 1, "both units bumped one row from one revision")

      const stored = await store.tasks.get(CONFORMANCE_SCOPES.first, "task-contended")
      assertEqual(stored?.revision, 2, "the bump that won is not the stored revision")
      assert(stored?.title === "First" || stored?.title === "Second", `the stored row carries neither bump: ${String(stored?.title)}`)
    }),

    conformanceCase("a preset revision assertion is a predicate of the unit that made it", async () => {
      const store = await start()
      await store.presets.insert(preset({ id: "preset-pinned", revision: 1 }))

      assertEqual(
        await store.presets.assertRevision(CONFORMANCE_SCOPES.first, "preset-pinned", 1),
        true,
        "the assertion refused the revision the row is at",
      )
      assertEqual(
        await store.presets.assertRevision(CONFORMANCE_SCOPES.first, "preset-pinned", 2),
        false,
        "the assertion accepted a revision the row is not at",
      )
      assertEqual(
        await store.presets.assertRevision(CONFORMANCE_SCOPES.first, "preset-absent", 1),
        false,
        "the assertion accepted a preset that does not exist",
      )
      assertEqual(
        await store.presets.assertRevision(CONFORMANCE_SCOPES.second, "preset-pinned", 1),
        false,
        "the assertion answered another scope from this one",
      )

      await store.transaction(async (tx) => {
        assertEqual(
          await tx.presets.assertRevision(CONFORMANCE_SCOPES.first, "preset-pinned", 1),
          true,
          "the assertion refused inside a unit the revision it accepted outside one",
        )
        await tx.tasks.insert(taskRow({ id: "task-settled" }))
      })
      assert(
        (await store.tasks.get(CONFORMANCE_SCOPES.first, "task-settled")) !== undefined,
        "the unit whose assertion held was refused",
      )

      await rollback(store, async (tx) => {
        assertEqual(
          await tx.presets.assertRevision(CONFORMANCE_SCOPES.first, "preset-pinned", 9),
          false,
          "the assertion accepted a revision no row is at",
        )
        await tx.tasks.insert(taskRow({ id: "task-stranded" }))
        throw new ConformanceRollback("the preset moved")
      })
      assertEqual(
        await store.tasks.get(CONFORMANCE_SCOPES.first, "task-stranded"),
        undefined,
        "the unit whose assertion missed kept its insert",
      )
      assertEqual(
        (await store.presets.get(CONFORMANCE_SCOPES.first, "preset-pinned"))?.revision,
        1,
        "the assertion wrote to the row it only read",
      )
    }),
    conformanceCase("a list row counts its own links and only this scope's", async () => {
      const { store } = await factory()
      await store.tasks.insert(taskRow({ id: "task-linked", createdAt: 3_000 }))
      await store.tasks.insert(taskRow({ id: "task-bare", createdAt: 2_000 }))
      await store.tasks.insert(taskRow({ id: "task-linked", scopeId: CONFORMANCE_SCOPES.second, createdAt: 3_000 }))
      await store.links.insert(linkRow({ taskId: "task-linked", attempt: 1 }))
      await store.links.insert(linkRow({ taskId: "task-linked", attempt: 2 }))
      await store.links.insert(linkRow({ taskId: "task-linked", slot: "review", attempt: 1 }))
      // The same task id in the other scope: a count that dropped the scope
      // would fold these two into the row above.
      await store.links.insert(linkRow({ taskId: "task-linked", scopeId: CONFORMANCE_SCOPES.second, attempt: 1 }))
      await store.links.insert(linkRow({ taskId: "task-linked", scopeId: CONFORMANCE_SCOPES.second, attempt: 2 }))

      const rows = await store.tasks.list(CONFORMANCE_SCOPES.first, TASK_LIST)
      const counts = new Map(rows.items.map((row) => [row.id, row.links.count]))
      assertEqual(counts.get("task-linked"), 3, "the row did not count its own links")
      assertEqual(counts.get("task-bare"), 0, "a task with no session was not counted as zero")
      assertEqual(
        (await store.tasks.list(CONFORMANCE_SCOPES.second, TASK_LIST)).items.find((row) => row.id === "task-linked")
          ?.links.count,
        2,
        "the other scope's row counted this scope's links",
      )
    }),
  ]
}

function conformanceCase(name: string, run: () => Promise<void>): TasksStoreConformanceCase {
  return { name, run }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`)
}
