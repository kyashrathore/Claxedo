/**
 * The Tasks grant a session's agent carries, and what one request costs it.
 *
 * The scope is minted by the control plane and verified by it; this module
 * owns only the shape both halves agree on and the rule that turns a request
 * into the operation it needs, so the hosted composition and the runtime host
 * cannot drift into two different answers about what `task_start` costs.
 */
import { asRecord } from "@claxedo/helpers/guards"
import { parseJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"

export type TasksOperation = "read" | "create" | "start"

export const TASKS_OPERATIONS: readonly TasksOperation[] = ["read", "create", "start"]

export function isTasksOperation(value: unknown): value is TasksOperation {
  return value === "read" || value === "create" || value === "start"
}

export type TasksCapabilityScope = Readonly<{
  userId: string
  orgId: string
  projectId: string
  workspaceId: string
  /** The session the runtime minted this for, when it was minted for one. */
  sessionId?: string
  operations: readonly TasksOperation[]
}>

/** One workspace's canonical owner, as the deployment's authority records it now. */
export type TasksCapabilityOwner = Readonly<{ userId: string; actorId: string; orgId: string; projectId: string }>

export type TasksCapabilityPort = Readonly<{
  /** The scope of a bearer this control plane minted, or undefined for anything else. */
  verify(token: string): Promise<TasksCapabilityScope | undefined>
  /**
   * Re-read at request time rather than trusted from the token. A capability
   * outlives nothing: the workspace it names decides who it acts as, so a
   * workspace that changed hands or was deleted ends the grant.
   */
  workspaceOwner(workspaceId: string): Promise<TasksCapabilityOwner | undefined>
}>

/** What one Tasks request costs a capability, and the names it would act under. */
export type TasksRequestCost = Readonly<{
  operation: TasksOperation
  projectId?: string
  /** The workspace a created task would prefer; absent when the body names none. */
  workspaceId?: string
  /** Whatever the create body put under `createdFrom`, absent only when the key is. */
  createdFrom?: unknown
}>

/**
 * The cost of a request, or undefined for a route no capability may reach.
 *
 * Reads are reads; creating a task is `create`; both halves of Start are
 * `start`. Every other command — editing, reparenting, archiving, anything a
 * preset owns — is refused here rather than given an operation, so widening
 * the grant is a change to this table and not to a caller.
 */
export async function tasksRequestCost(request: Request): Promise<TasksRequestCost | undefined> {
  const url = new URL(request.url)
  if (request.method === "GET") {
    const projectId = url.searchParams.get("projectId")
    return { operation: "read", ...(projectId ? { projectId } : {}) }
  }
  if (request.method !== "POST") return undefined
  if (url.pathname.endsWith("/start-preview") || url.pathname.endsWith("/sessions")) return { operation: "start" }
  if (!url.pathname.endsWith("/commands")) return undefined
  // The route reads the body again through Hono's own cache; consuming the
  // original here would leave it with nothing to parse.
  const body = parseJsonRecord(await request.clone().text())
  const command = asRecord(body?.command)
  if (stringField(command, "type") !== "task.create") return undefined
  const input = asRecord(command?.input)
  const projectId = stringField(input, "projectId")
  const workspaceId = stringField(input, "workspaceId")
  return {
    operation: "create",
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(input?.createdFrom === undefined ? {} : { createdFrom: input.createdFrom }),
  }
}
