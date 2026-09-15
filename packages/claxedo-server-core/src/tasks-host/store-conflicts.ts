/**
 * Which predicate a failed Tasks write broke, as every durable adapter answers
 * it.
 *
 * A store reports a conflict after the fact: D1 commits a unit as one batch
 * that names no statement when it refuses, and SQLite's unique indexes throw a
 * driver error that names columns rather than the rule they enforce. Both
 * therefore re-read the predicates that were true when the operation answered
 * its caller, and the first one that has stopped holding is the conflict. The
 * kind, the order and the wording live here so the same race is the same answer
 * on desktop and hosted rather than a 409 on one and a 500 on the other.
 */
import { TASKS_STORE_CONFLICTS, TasksStoreConflict, type TasksStoreConflictKind } from "@claxedo/tasks"

/** A predicate an operation reported as holding, and the committed read that says whether it still does. */
export type TasksConflictProbe = Readonly<{
  kind: TasksStoreConflictKind
  broken: () => Promise<string | undefined>
}>

export function taskNumberTakenRefusal(projectId: string, number: string): string {
  return `task number ${number} in project ${projectId} was taken by another task`
}

/**
 * The conflict a failed write was, or undefined when no predicate explains it —
 * which is a fault and has to keep travelling as the driver's own error.
 *
 * Probes are read in the order a caller owes its client an answer, so a commit
 * that broke both a receipt's uniqueness and a revision reports the receipt:
 * that command already happened and its committed result is the reply.
 */
export async function tasksStoreConflict(
  probes: readonly TasksConflictProbe[],
  cause: unknown,
): Promise<TasksStoreConflict | undefined> {
  const ordered = [...probes].sort(
    (left, right) => TASKS_STORE_CONFLICTS.indexOf(left.kind) - TASKS_STORE_CONFLICTS.indexOf(right.kind),
  )
  for (const probe of ordered) {
    const broken = await probe.broken()
    if (broken) return new TasksStoreConflict(probe.kind, broken, { cause })
  }
  return undefined
}
