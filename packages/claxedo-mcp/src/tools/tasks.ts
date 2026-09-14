/**
 * Tasks as the agent inside a session uses them: read the project's tasks,
 * write one down, and start a task's session on an execution preset.
 *
 * The mount decides whether these exist at all. It hands the client a fetch
 * onto the control plane's Tasks routes and the operations that grant carries,
 * and a deployment without Tasks hands it nothing — so every answer here is a
 * sentence rather than a stack trace, the way the documents tools answer a
 * deployment that serves no documents service.
 */
import { z } from "zod"
import {
  createTasksClient,
  TASKS_ROUTE_PATH,
  TasksApiError,
  TasksClientPayloadError,
  type TasksClient,
} from "@claxedo/tasks/client"
import type { ConfigurationSlot, Preset, SessionReference, TaskSessionLinkView, TaskSummary } from "@claxedo/tasks"
import { CONFIGURATION_SLOTS, TASK_CREATE_STATUSES, TASK_STATUSES, admissibleAttempt } from "@claxedo/tasks"
import { record, text } from "../json"
import type { McpToolContext } from "../context"
import { mcpToolRefusal, type McpToolResult } from "../mcp-tool"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { targetScope, toolJson, toolTarget } from "./target"

const PROJECT_ARG = {
  project: z.string().trim().min(1).optional().describe("Project id. Defaults to the project of this session's own workspace."),
} as const

const TASK_ARG = { task: z.string().trim().min(1).describe("Task id.") } as const

export function registerTaskTools(registry: ToolRegistrar) {
  registry.tool(
    "task_list",
    {
      description: "List a project's tasks: id, number, title, status, parent, how many sessions each has run and how its subtasks stand.",
      inputSchema: {
        ...PROJECT_ARG,
        status: z.enum(TASK_STATUSES).optional().describe("Only tasks in this status."),
        limit: z.number().int().min(1).max(100).optional().describe("Rows per page. Defaults to the service's own page size."),
        cursor: z.string().min(1).optional().describe("`nextCursor` from a previous call."),
      },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: false, scope: "read", operation: "read" }),
    },
    async (args, ctx) => tasksRefusals(async () => {
      await auditRead(ctx, "task_list", args)
      const client = tasksClient(ctx)
      const projectId = await projectOf(ctx, args.project)
      const page = await client.listTasks({
        projectId,
        ...(args.status ? { status: args.status } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
      })
      return toolJson({ project: projectId, tasks: page.items.map(taskListRow), nextCursor: page.nextCursor })
    }),
  )

  registry.tool(
    "task_get",
    {
      description: "One task in full, with every session it has run: the slot, the attempt, the preset it started on, and whether that session is still live.",
      inputSchema: { ...TASK_ARG },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: false, scope: "read", operation: "read" }),
    },
    async (args, ctx) => tasksRefusals(async () => {
      await auditRead(ctx, "task_get", args)
      const detail = await tasksClient(ctx).getTask(args.task)
      return toolJson({ task: detail.task, links: detail.links })
    }),
  )

  registry.tool(
    "task_create",
    {
      description:
        "Write down a task in this session's project. `todo` is ready to pick up and `backlog` is parked. A task created from inside a session records the session it came from.",
      inputSchema: {
        title: z.string().trim().min(1).describe("What the task is, in one line."),
        description: z.string().optional().describe("The task in full, as Markdown."),
        status: z.enum(TASK_CREATE_STATUSES).optional().describe("Defaults to todo."),
        parent: z.string().trim().min(1).optional().describe("Task id this one is a subtask of."),
        ...PROJECT_ARG,
        clientRequestId: z
          .string()
          .min(1)
          .optional()
          .describe("Retrying with the same id returns the task already created instead of creating another."),
      },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: true, scope: "act", operation: "create" }),
    },
    async (args, ctx) => tasksRefusals(async () => {
      const client = tasksClient(ctx)
      const projectId = await projectOf(ctx, args.project)
      const createdFrom = callingSession(ctx)
      const response = await client.command({
        clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
        command: {
          type: "task.create",
          input: {
            projectId,
            title: args.title,
            description: args.description ?? "",
            // The task belongs to the project, not to the machine that wrote it
            // down: pinning it here would send every later attempt to this
            // session's workspace. The app's own create leaves it null too.
            workspaceId: null,
            parentTaskId: args.parent ?? null,
            ...(args.status ? { status: args.status } : {}),
            ...(createdFrom ? { createdFrom } : {}),
          },
        },
      })
      if (response.result.type !== "task.create") {
        return mcpToolRefusal(`The Tasks service answered a task.create with a ${response.result.type} result.`)
      }
      const { task } = response.result
      return toolJson({
        task: { id: task.id, number: task.number, title: task.title, status: task.status, parent: task.parentTaskId, project: task.projectId, createdFrom: task.createdFrom },
        replayed: response.replayed,
      })
    }),
  )

  registry.tool(
    "task_start",
    {
      description:
        "Start a task's session on an execution preset and link it to the task. Runs the host's own preview first and sends nothing when the preview reports a blocker. A slot whose session is still live is returned as it is rather than started again.",
      inputSchema: {
        ...TASK_ARG,
        preset: z.string().trim().min(1).optional().describe("Preset id or name. Optional only while the account has exactly one preset."),
        slot: z.enum(CONFIGURATION_SLOTS).optional().describe("Which configuration of the preset to run. Defaults to primary."),
        continue: z.boolean().optional().describe("Hand the slot's previous session over to the new one. Defaults to false."),
        clientRequestId: z
          .string()
          .min(1)
          .optional()
          .describe("Retrying with the same id returns the session already started instead of starting another."),
      },
      access: declaredToolAccess({ audiences: ["runtime", "user"], write: true, scope: "act", operation: "start" }),
      sessionIdFromHandler: true,
    },
    async (args, ctx, addressed) => tasksRefusals(async () => {
      const client = tasksClient(ctx)
      const detail = await client.getTask(args.task)
      const slot = args.slot ?? "primary"
      const preset = await presetFor(client, args.preset)
      const attempt = nextAttempt(detail.links, slot)
      const continueFromPrevious = args.continue ?? false
      const { preview } = await client.startPreview(args.task, {
        taskRevision: detail.task.revision,
        presetId: preset.id,
        presetRevision: preset.revision,
        slot,
        attempt,
        continueFromPrevious,
      })
      if (!preview.available || preview.blockers.length > 0) {
        const blockers = preview.blockers.map((blocker) => blocker.detail)
        return mcpToolRefusal(
          blockers.length > 0
            ? blockers.join("\n")
            : `${preset.name} cannot start ${slot} for this task, and the host named no reason.`,
        )
      }
      const started = await client.start(args.task, {
        clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
        taskRevision: detail.task.revision,
        presetId: preset.id,
        presetRevision: preset.revision,
        slot,
        attempt,
        previewDigest: preview.digest,
        handoffText: null,
        continueFromPrevious,
      })
      addressed?.(started.link.sessionRef.sessionId)
      return toolJson({
        session: started.link.sessionRef,
        slot: started.link.slot,
        attempt: started.link.attempt,
        preset: { id: started.link.presetId, name: started.link.presetNameAtStart },
        placement: preview.placement,
        destination: preview.destinationDescription,
        created: started.created,
      })
    }),
  )
}

/** The session this call is made from, as the Tasks contract records provenance. */
function callingSession(ctx: McpToolContext): SessionReference | undefined {
  const { credential } = ctx
  if (credential.kind !== "runtime" || !credential.sessionId) return undefined
  return { sessionId: credential.sessionId, workspaceId: credential.workspaceId }
}

/** The slot's current link is its highest attempt; the kit says which attempt that link admits next. */
function nextAttempt(links: readonly TaskSessionLinkView[], slot: ConfigurationSlot): number {
  const current = links.filter((link) => link.slot === slot).sort((a, b) => b.attempt - a.attempt)[0]
  return admissibleAttempt(current)
}

/**
 * Which preset to start on: the id, or the name as the user wrote it in
 * Settings, since an agent rarely holds an id.
 *
 * The routes page a personal catalog by the store's own cursor and record
 * nothing about which preset was used last, so there is no "the usual one" to
 * default to. A single preset is the whole catalog and needs no naming; past
 * that the refusal carries every id and name, because nothing else here lists
 * them.
 */
async function presetFor(client: TasksClient, requested: string | undefined): Promise<Preset> {
  if (requested) {
    try {
      return await client.getPreset(requested)
    } catch (cause) {
      if (!(cause instanceof TasksApiError) || cause.status !== 404) throw cause
    }
  }
  const seen: Preset[] = []
  let cursor: string | undefined
  do {
    const page = await client.listPresets(cursor ? { cursor } : {})
    if (requested) {
      const named = page.items.find((preset) => preset.name.toLowerCase() === requested.toLowerCase())
      if (named) return named
    }
    seen.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  if (requested) throw new RefusalSentence(`No preset is named ${requested}. The presets are: ${catalog(seen)}.`)
  const only = seen[0]
  if (!only) {
    throw new RefusalSentence("This account has no execution preset, and a task's session starts from one. Create a preset first.")
  }
  if (seen.length > 1) throw new RefusalSentence(`Name the preset to start on: ${catalog(seen)}.`)
  return only
}

function catalog(presets: readonly Preset[]): string {
  return presets.map((preset) => `${preset.id} (${preset.name})`).join(", ")
}

function taskListRow(task: TaskSummary) {
  return {
    id: task.id,
    number: task.number,
    title: task.title,
    status: task.status,
    parent: task.parentTaskId,
    hasDescription: task.hasDescription,
    sessions: task.links.count,
    subtasks: task.children,
    updatedAt: task.updatedAt,
  }
}

/**
 * Something the caller has to be told rather than something to throw: no Tasks
 * in this deployment, a service out of reach, or a choice only they can make.
 */
class RefusalSentence extends Error {}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The registry records a write before it runs it; a Tasks read is recorded
 * here because it reaches the account's own tasks from inside a session, which
 * is as much a thing to have a record of as a write.
 */
function auditRead(ctx: McpToolContext, tool: string, args: Record<string, unknown>) {
  return ctx.audit({ tool, credential: ctx.credential, args })
}

/**
 * Every refusal the Tasks routes and their client can produce, as the tool's
 * own answer instead of an exception the host renders as a crash. A refusal
 * the service wrote — a task that is not there, a revision that has moved —
 * is passed on in its own words, since it already names what happened.
 */
async function tasksRefusals(handle: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await handle()
  } catch (error) {
    if (error instanceof RefusalSentence) return mcpToolRefusal(error.message)
    if (error instanceof TasksApiError) return mcpToolRefusal(error.detail.message)
    if (error instanceof TasksClientPayloadError) {
      return mcpToolRefusal(`The Tasks service answered with something that is not a tasks response: ${error.message}`)
    }
    throw error
  }
}

function tasksClient(ctx: McpToolContext): TasksClient {
  const grant = ctx.client.tasks
  if (!grant) throw new RefusalSentence("This Claxedo deployment does not serve Tasks.")
  return createTasksClient({
    baseUrl: TASKS_ROUTE_PATH,
    request: async (path, init) => {
      try {
        return await grant.fetch(path, init)
      } catch (error) {
        throw new RefusalSentence(`The Tasks service could not be reached from this session: ${causeOf(error)}.`)
      }
    },
  })
}

/**
 * The project a task belongs to: the one named, the one this grant is confined
 * to, or the one this session's own workspace sits in.
 *
 * A named project outside a confined grant is refused here by name. The
 * control plane refuses it too, but sending it would put a project this
 * session was never given into the account's audit trail and answer the model
 * with a forbidden it cannot act on.
 */
async function projectOf(ctx: McpToolContext, requested: string | undefined): Promise<string> {
  const granted = ctx.client.tasks?.projectId
  if (granted && requested && requested !== granted) {
    throw new RefusalSentence(`This session's Tasks grant is confined to project ${granted}; it cannot work in ${requested}.`)
  }
  if (requested) return requested
  if (granted) return granted
  const target = toolTarget(ctx, {})
  let response: Response
  try {
    const runtime = await ctx.client.runtime(target)
    response = await runtime(`/project/current?${new URLSearchParams(targetScope(target))}`)
  } catch (error) {
    throw new RefusalSentence(`This session's own project could not be read, so name the project: ${causeOf(error)}.`)
  }
  if (!response.ok) throw new RefusalSentence("This session's workspace has no project of its own; name the project to work in.")
  const id = text(record(await response.json().catch(() => undefined))?.id)
  if (!id) throw new RefusalSentence("The project route answered without a project id; name the project to work in.")
  return id
}
