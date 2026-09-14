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
import { TasksStoreConflict, type TasksStorePort } from "../ports/store"
import { gate, settle } from "../test-support/concurrency"
import { OWNER, SCOPES, linkRow, presetRow, receiptRow, taskRow } from "../test-support/rows"

export const TASKS_STORE_CONFORMANCE_VERSION = 8 as const

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
    "a_list_row_counts_every_live_child_not_the_ones_a_page_returned",
    "task_numbers_are_minted_per_project_and_carried_on_reads",
    "an_archived_task_keeps_its_number_and_the_next_one_does_not_reuse_it",
    "a_task_created_from_a_session_reads_that_session_back_on_get_list_and_children",
    "a_preset_marked_startable_by_agents_reads_the_mark_back_on_get_and_list",
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

export const CONFORMANCE_SCOPES = SCOPES

const LIST = { cursor: null, limit: 50, includeArchived: false } as const
const TASK_LIST = { ...LIST, projectId: "project-alpha", status: null, parent: "any" } as const

class ConformanceRollback extends Error {}

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
      assertEqual(anchor?.title, "Ship the thing", "the refused update rewrote the row")
    }),

    conformanceCase("a zero-row update cannot leave a receipt behind", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-receipted", revision: 2 }))

      await rollback(store, async (tx) => {
        const written = await tx.receipts.put(
          receiptRow({ clientRequestId: "request-doomed", result: { type: "task.archive", task: taskRow({ id: "task-receipted" }), parent: null } }),
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
      const committed = receiptRow({
        clientRequestId: "request-once",
        requestHash: "hash-a",
        result: { type: "task.create", task: taskRow({ id: "task-committed" }), parent: null },
      })
      assertEqual(await store.receipts.put(committed), true, "the first receipt for a fresh request id was refused")
      assertEqual(
        await store.receipts.put(receiptRow({ clientRequestId: "request-once", requestHash: "hash-b", result: { type: "task.archive", task: taskRow({ id: "task-other" }), parent: null } })),
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
      await store.presets.insert(presetRow({ id: "preset-alpha" }))
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
      assertEqual((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-alpha"))?.title, "Ship the thing", "the foreign update wrote through")
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
      await store.presets.insert(presetRow({ id: "preset-pinned", revision: 1 }))

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
      const store = await start()
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

    conformanceCase("a list row counts every live child, not the ones a page returned", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-parent", createdAt: 5_000 }))
      await store.tasks.insert(taskRow({ id: "task-childless", createdAt: 4_000 }))
      await store.tasks.insert(
        taskRow({ id: "child-open", parentTaskId: "task-parent", status: "todo", createdAt: 3_000 }),
      )
      await store.tasks.insert(
        taskRow({ id: "child-done", parentTaskId: "task-parent", status: "done", createdAt: 2_000 }),
      )
      // Archived children are neither owed nor finished.
      await store.tasks.insert(
        taskRow({ id: "child-gone", parentTaskId: "task-parent", status: "todo", archivedAt: 9, createdAt: 1_000 }),
      )
      // Another scope's child of the same parent id must not be counted here.
      await store.tasks.insert(
        taskRow({
          id: "child-elsewhere",
          scopeId: CONFORMANCE_SCOPES.second,
          parentTaskId: "task-parent",
          createdAt: 1_500,
        }),
      )

      // One row per page, so the counts cannot have come from the page's rows.
      const page = await store.tasks.list(CONFORMANCE_SCOPES.first, { ...TASK_LIST, limit: 1, parent: "root" })
      const parent = page.items.find((row) => row.id === "task-parent")
      assertEqual(parent?.children.total, 2, "the parent did not count every live child it holds")
      assertEqual(parent?.children.done, 1, "the parent did not count the child that is done")

      const all = await store.tasks.list(CONFORMANCE_SCOPES.first, { ...TASK_LIST, parent: "root" })
      assertEqual(
        all.items.find((row) => row.id === "task-childless")?.children.total,
        0,
        "a task with no children was not counted as zero",
      )
      assertEqual(
        all.items.find((row) => row.id === "task-childless")?.children.done,
        0,
        "a task with no children reported finished work",
      )
    }),

    conformanceCase("task numbers are minted per project and carried on reads", async () => {
      const store = await start()
      assertEqual(await store.tasks.nextNumber(CONFORMANCE_SCOPES.first, "project-alpha"), 1, "an empty project did not start at one")

      await store.tasks.insert(taskRow({ id: "task-one", number: 1, createdAt: 3_000 }))
      assertEqual(await store.tasks.nextNumber(CONFORMANCE_SCOPES.first, "project-alpha"), 2, "the second number does not follow the first")
      await store.tasks.insert(taskRow({ id: "task-two", number: 2, createdAt: 2_000 }))
      assertEqual(await store.tasks.nextNumber(CONFORMANCE_SCOPES.first, "project-alpha"), 3, "the numbers are not contiguous")

      assertEqual(
        await store.tasks.nextNumber(CONFORMANCE_SCOPES.first, "project-beta"),
        1,
        "a second project continued the first one's sequence",
      )
      await store.tasks.insert(taskRow({ id: "task-beta", projectId: "project-beta", number: 1 }))
      assertEqual(
        await store.tasks.nextNumber(CONFORMANCE_SCOPES.first, "project-alpha"),
        3,
        "another project's rows moved this project's sequence",
      )

      assertEqual((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-two"))?.number, 2, "a read dropped the task's number")
      const page = await store.tasks.list(CONFORMANCE_SCOPES.first, TASK_LIST)
      assertEqual(page.items.find((row) => row.id === "task-one")?.number, 1, "a list row dropped the task's number")
    }),

    conformanceCase("an archived task keeps its number and the next one does not reuse it", async () => {
      const store = await start()
      await store.tasks.insert(taskRow({ id: "task-open", number: 1 }))
      await store.tasks.insert(taskRow({ id: "task-gone", number: 2, archivedAt: 9 }))

      assertEqual(
        await store.tasks.nextNumber(CONFORMANCE_SCOPES.first, "project-alpha"),
        3,
        "the archived task's number was handed out again",
      )
      assertEqual(
        (await store.tasks.get(CONFORMANCE_SCOPES.first, "task-gone"))?.number,
        2,
        "the archived task lost the number it was created with",
      )
    }),

    conformanceCase("a task created from a session reads that session back on get, list and children", async () => {
      const store = await start()
      const origin = { sessionId: "session-author", workspaceId: "workspace-author" }
      await store.tasks.insert(taskRow({ id: "task-from-session", createdFrom: origin, createdAt: 4_000 }))
      await store.tasks.insert(
        taskRow({ id: "child-from-session", parentTaskId: "task-from-session", createdFrom: origin, createdAt: 3_000 }),
      )
      // A local session has no workspace, and a row keyed on the workspace
      // column would read this one as created by nobody.
      await store.tasks.insert(
        taskRow({ id: "task-from-local", createdFrom: { sessionId: "session-local", workspaceId: null }, createdAt: 2_000 }),
      )
      await store.tasks.insert(taskRow({ id: "task-from-the-app", createdAt: 1_000 }))

      const stored = await store.tasks.get(CONFORMANCE_SCOPES.first, "task-from-session")
      assertEqual(stored?.createdFrom?.sessionId, "session-author", "a read dropped the session the task was created from")
      assertEqual(stored?.createdFrom?.workspaceId, "workspace-author", "a read dropped the creating session's workspace")

      const local = await store.tasks.get(CONFORMANCE_SCOPES.first, "task-from-local")
      assertEqual(local?.createdFrom?.sessionId, "session-local", "a creating session without a workspace was read as none")
      assertEqual(local?.createdFrom?.workspaceId, null, "a creating session was given a workspace it never named")

      assertEqual(
        (await store.tasks.get(CONFORMANCE_SCOPES.first, "task-from-the-app"))?.createdFrom,
        null,
        "a task nobody created from a session came back with one",
      )

      const page = await store.tasks.list(CONFORMANCE_SCOPES.first, TASK_LIST)
      assertEqual(
        page.items.find((row) => row.id === "task-from-session")?.createdFrom?.sessionId,
        "session-author",
        "a list row dropped the session the task was created from",
      )
      const children = await store.tasks.listChildren(CONFORMANCE_SCOPES.first, "task-from-session", LIST)
      assertEqual(
        children.items.find((row) => row.id === "child-from-session")?.createdFrom?.sessionId,
        "session-author",
        "a child row dropped the session the task was created from",
      )
    }),

    conformanceCase("a preset marked startable by agents reads the mark back on get and list", async () => {
      const store = await start()
      await store.presets.insert(presetRow({ id: "preset-marked", agentStartable: true, createdAt: 2_000 }))
      await store.presets.insert(presetRow({ id: "preset-unmarked", agentStartable: false, createdAt: 1_000 }))

      assertEqual((await store.presets.get(CONFORMANCE_SCOPES.first, "preset-marked"))?.agentStartable, true, "a read dropped the mark")
      assertEqual(
        (await store.presets.get(CONFORMANCE_SCOPES.first, "preset-unmarked"))?.agentStartable,
        false,
        "a preset nobody marked was read as startable by agents",
      )
      const page = await store.presets.list(CONFORMANCE_SCOPES.first, OWNER, LIST)
      assertEqual(page.items.find((row) => row.id === "preset-marked")?.agentStartable, true, "a list row dropped the mark")

      assertEqual(
        await store.presets.update(presetRow({ id: "preset-marked", revision: 2, agentStartable: false }), 1),
        true,
        "the update that clears the mark was refused",
      )
      assertEqual(
        (await store.presets.get(CONFORMANCE_SCOPES.first, "preset-marked"))?.agentStartable,
        false,
        "an update did not clear the mark",
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
