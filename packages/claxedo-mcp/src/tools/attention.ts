import { z } from "zod"
import { errorMessage, sleep } from "@claxedo/helpers"
import type { AgentPermission, AgentPresentationSession, AgentQuestion, AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { WorkspaceRuntimeClientTransportError, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { ClaxedoMcpClient, WorkspaceTarget } from "../client/contract"
import { assertToolAccess, McpAccessDenied, toolListed, type McpToolAccess, type McpToolContext } from "../context"
import { mcpToolRefusal, type McpToolResult } from "../mcp-tool"
import type { ToolRegistrar } from "./registry"
import { assertWritableTarget, toolTarget, toolText, WORKSPACE_TARGET_SCHEMA, type WorkspaceTargetArgs } from "./target"

const PERMISSION_REPLY = "permission_reply"

export const WAIT_FOR_ATTENTION_MAX_MS = 50_000

const WAIT_POLL_MS = 1_000

const PERMISSION_RESPONSES = ["once", "always", "reject"] as const

type PermissionResponse = (typeof PERMISSION_RESPONSES)[number]

const BOARD_ACCESS: McpToolAccess = { audiences: ["user"], write: false, scope: "read" }
const APPROVE_ACCESS: McpToolAccess = { audiences: ["user"], write: true, scope: "approve" }
const QUESTION_REPLY_ACCESS: McpToolAccess = { audiences: ["user", "runtime"], write: true, scope: "approve" }

/**
 * `timeoutMs` is clamped rather than rejected: a host that hard-codes its own
 * tool timeout (Codex CLI's `tool_timeout_sec` is 60) sends a number this
 * server has to survive, and a validation error would lose the poll entirely.
 */
export function boundedWaitMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return WAIT_FOR_ATTENTION_MAX_MS
  return Math.max(0, Math.min(requested, WAIT_FOR_ATTENTION_MAX_MS))
}

type BoardTarget = Readonly<{ label: string; target: WorkspaceTarget; offline?: string }>

type WorkspacePending = Readonly<{
  entry: BoardTarget
  unreachable?: string
  permissions: readonly AgentPermission[]
  questions: readonly AgentQuestion[]
  status: Readonly<Record<string, AgentRuntimeStatus>>
}>

type WorkspaceBoard = WorkspacePending & Readonly<{ sessions: ReadonlyMap<string, AgentPresentationSession> }>

function workspaceLabel(input: Readonly<{ id?: string; name?: string; kind: string }>): string {
  const name = input.name ? ` (${input.name})` : ""
  return `${input.id ?? "this workspace"}${name} — ${input.kind}`
}

/**
 * The workspaces one credential can see. The control plane answers the
 * account's list; a client with no control plane reaches only the runtime in
 * its own process, which is the whole of a loopback or unsigned node mount.
 */
async function boardTargets(client: ClaxedoMcpClient): Promise<{ entries: readonly BoardTarget[]; problem?: string }> {
  const entries: BoardTarget[] = []
  let problem: string | undefined
  if (client.controlPlane) {
    try {
      for (const row of await client.workspaces()) {
        entries.push({
          label: workspaceLabel(row),
          target: { workspaceId: row.id, ...(row.directory ? { directory: row.directory } : {}) },
          ...(row.machineOnline === false ? { offline: "machine offline" } : {}),
        })
      }
    } catch (error) {
      problem = `Could not list workspaces: ${errorMessage(error)}`
    }
  }
  const own = client.ownWorkspace
  if (own && !entries.some((entry) => own.workspaceId && entry.target.workspaceId === own.workspaceId)) {
    entries.unshift({ label: workspaceLabel({ ...(own.workspaceId ? { id: own.workspaceId } : {}), kind: client.deployment }), target: own })
  }
  return { entries, ...(problem ? { problem } : {}) }
}

/**
 * A machine the credential can name but not reach is a distinct answer from a
 * machine with nothing waiting, so a failed hop becomes a line rather than an
 * empty list; a transport failure is the offline case, anything else says what
 * it was.
 */
async function readPending(client: ClaxedoMcpClient, entry: BoardTarget): Promise<WorkspacePending> {
  const empty = { entry, permissions: [], questions: [], status: {} } as const
  if (entry.offline) return { ...empty, unreachable: entry.offline }
  try {
    const server = await client.server(entry.target)
    const [permissions, questions, status] = await Promise.all([
      server.permission.list(),
      server.question.list(),
      server.session.status(),
    ])
    return { entry, permissions: permissions.data, questions: questions.data, status: status.data }
  } catch (error) {
    return {
      ...empty,
      unreachable: error instanceof WorkspaceRuntimeClientTransportError
        ? `machine offline: ${errorMessage(error)}`
        : `unreachable: ${errorMessage(error)}`,
    }
  }
}

/**
 * The sessions the board names: the roots the runtime lists, plus every
 * session carrying a pending item and every ancestor up to its root. `GET
 * /permission` is directory-scoped and so already lists children, which a root
 * listing never does.
 *
 * A session whose parent is absent is neither a root nor an orphan and renders
 * nowhere, so the ancestor walk has to reach a root. Iterating the map's own
 * `values()` visits the entries the walk inserts, which carries it up a chain
 * of any depth; it terminates because a parent already in the map is skipped.
 */
async function boardSessions(server: WorkspaceRuntimeClient, pending: WorkspacePending): Promise<Map<string, AgentPresentationSession>> {
  const sessions = new Map<string, AgentPresentationSession>()
  try {
    for (const row of (await server.session.list({})).data) sessions.set(row.id, row)
  } catch {
    // A runtime that answers the pending lists but not the root listing still
    // has attention worth reporting.
  }
  const wanted = new Set([...pending.permissions.map((row) => row.sessionID), ...pending.questions.map((row) => row.sessionID)])
  for (const id of wanted) {
    if (sessions.has(id)) continue
    const row = await server.session.get({ sessionID: id }).catch(() => undefined)
    if (row) sessions.set(row.data.id, row.data)
  }
  for (const row of sessions.values()) {
    const parent = row.parentID
    if (!parent || sessions.has(parent)) continue
    const found = await server.session.get({ sessionID: parent }).catch(() => undefined)
    if (found) sessions.set(found.data.id, found.data)
  }
  return sessions
}

async function readBoard(client: ClaxedoMcpClient, entry: BoardTarget): Promise<WorkspaceBoard> {
  const pending = await readPending(client, entry)
  if (pending.unreachable) return { ...pending, sessions: new Map() }
  const server = await client.server(entry.target)
  return { ...pending, sessions: await boardSessions(server, pending) }
}

function statusText(status: AgentRuntimeStatus | undefined): string {
  if (!status) return "unknown"
  return status.type === "retry" ? `retry (attempt ${status.attempt})` : status.type
}

function permissionLine(row: AgentPermission): string {
  const detail = row.title ?? row.permission
  return `permission ${row.id} — ${detail}`
}

function questionLine(row: AgentQuestion): string {
  const first = row.questions[0]
  const options = first?.options.map((option) => option.label).join(" | ")
  return `question ${row.id} — ${first?.question ?? "(no prompt)"}${options ? ` [${options}]` : ""}`
}

function sessionBlock(board: WorkspaceBoard, id: string, indent: string): string[] {
  const session = board.sessions.get(id)
  const title = session?.title ? ` "${session.title}"` : ""
  const lines = [`${indent}${id}${title}  ${statusText(board.status[id])}`]
  for (const row of board.permissions.filter((permission) => permission.sessionID === id)) {
    lines.push(`${indent}  ${permissionLine(row)}`)
  }
  for (const row of board.questions.filter((question) => question.sessionID === id)) {
    lines.push(`${indent}  ${questionLine(row)}`)
  }
  for (const child of board.sessions.values()) {
    if (child.parentID === id) lines.push(...sessionBlock(board, child.id, `${indent}  `))
  }
  return lines
}

function renderBoard(board: WorkspaceBoard): string[] {
  const lines = [board.entry.label]
  if (board.unreachable) return [...lines, `  ${board.unreachable}`]
  const roots = [...board.sessions.values()].filter((session) => !session.parentID).map((session) => session.id)
  const orphans = new Set(
    [...board.permissions.map((row) => row.sessionID), ...board.questions.map((row) => row.sessionID)].filter((id) => !board.sessions.has(id)),
  )
  const ids = [...roots, ...orphans]
  if (ids.length === 0) return [...lines, "  nothing waiting"]
  for (const id of ids) lines.push(...sessionBlock(board, id, "  "))
  return lines
}

/**
 * Undefined means the call named no workspace and the endpoint serves none of
 * its own, which the hosted mount would otherwise answer with a client error
 * about an unresolvable target rather than something a person can act on.
 */
function attentionWriteTarget(ctx: McpToolContext, tool: string, args: WorkspaceTargetArgs): WorkspaceTarget | undefined {
  const target = toolTarget(ctx, args)
  if (!target.workspaceId && !ctx.client.ownWorkspace) return undefined
  assertWritableTarget(ctx, tool, target)
  return target
}

const NAME_A_WORKSPACE = "Name the workspace: this endpoint serves no workspace of its own"

/** The one place a permission decision reaches a runtime, and the one gate in front of it. */
export async function replyToPermission(
  ctx: McpToolContext,
  target: WorkspaceTarget,
  input: Readonly<{ sessionID: string; permissionID: string; response: PermissionResponse }>,
): Promise<void> {
  assertToolAccess(ctx.credential, PERMISSION_REPLY, APPROVE_ACCESS)
  const server = await ctx.client.server(target)
  await server.permission.respond(input)
}

function elicitedPermissionResponse(value: unknown): PermissionResponse | undefined {
  return PERMISSION_RESPONSES.find((candidate) => candidate === value)
}

/**
 * The pending permission answered where the host can ask a person. A client
 * that declared elicitation but auto-accepts its own dialog is still bound by
 * the `approve` scope, which is why the gate is checked before the prompt.
 */
async function elicitPermission(
  ctx: McpToolContext,
  entry: BoardTarget,
  row: AgentPermission,
): Promise<McpToolResult> {
  const answer = await ctx.elicit?.({
    mode: "form",
    message: `${row.title ?? row.permission} — session ${row.sessionID}`,
    requestedSchema: {
      type: "object",
      properties: {
        response: {
          type: "string",
          title: "Response",
          enum: [...PERMISSION_RESPONSES],
          enumNames: ["Allow once", "Allow always", "Deny"],
        },
      },
      required: ["response"],
    },
  })
  if (!answer || answer.action !== "accept") {
    return toolText(`${permissionLine(row)} is still pending in ${entry.label}; it was not answered.`)
  }
  const response = elicitedPermissionResponse(answer.content?.response)
  if (!response) return mcpToolRefusal(`The host answered with no usable response for permission ${row.id}`)
  await ctx.audit({
    tool: PERMISSION_REPLY,
    credential: ctx.credential,
    args: { session: row.sessionID, permission: row.id, response },
    sessionId: row.sessionID,
  })
  await replyToPermission(ctx, entry.target, { sessionID: row.sessionID, permissionID: row.id, response })
  return toolText(`Answered permission ${row.id} on session ${row.sessionID} with "${response}".`)
}

function firstPending(boards: readonly WorkspacePending[]):
  | Readonly<{ entry: BoardTarget; permission: AgentPermission }>
  | Readonly<{ entry: BoardTarget; question: AgentQuestion }>
  | undefined {
  for (const board of boards) {
    const [permission] = board.permissions
    if (permission) return { entry: board.entry, permission }
  }
  for (const board of boards) {
    const [question] = board.questions
    if (question) return { entry: board.entry, question }
  }
  return undefined
}

function namedStatus(boards: readonly WorkspacePending[], session: string): string {
  for (const board of boards) {
    const status = board.status[session]
    if (status) return statusText(status)
  }
  return "unknown"
}

export function registerAttentionTools(registry: ToolRegistrar): void {
  registry.tool("sessions_board", {
    description:
      "Everything waiting for you, grouped by workspace: pending permissions, pending questions and session status, "
      + "read live from each workspace's runtime. Child sessions appear under their parent. "
      + "A machine that cannot be reached is reported as offline rather than as having nothing waiting.",
    inputSchema: {},
    access: BOARD_ACCESS,
  }, async (_args, ctx) => {
    const { entries, problem } = await boardTargets(ctx.client)
    const lines = problem ? [problem] : []
    if (entries.length === 0) return toolText([...lines, "No workspace is visible to this credential."].join("\n"))
    const boards = await Promise.all(entries.map((entry) => readBoard(ctx.client, entry)))
    for (const board of boards) lines.push(...renderBoard(board))
    return toolText(lines.join("\n"))
  })

  registry.tool(PERMISSION_REPLY, {
    description: "Answer a pending permission request on a session. People only: an agent never approves its own work.",
    inputSchema: {
      session: z.string().min(1).describe("Session the permission was raised on."),
      permission: z.string().min(1).describe("Permission id from sessions_board."),
      response: z.enum(PERMISSION_RESPONSES).describe("once allows this call, always allows the pattern, reject denies it."),
      ...WORKSPACE_TARGET_SCHEMA,
    },
    access: APPROVE_ACCESS,
    sessionIdOf: (args) => args.session,
  }, async (args, ctx) => {
    const target = attentionWriteTarget(ctx, PERMISSION_REPLY, args)
    if (!target) return mcpToolRefusal(NAME_A_WORKSPACE)
    await replyToPermission(ctx, target, { sessionID: args.session, permissionID: args.permission, response: args.response })
    return toolText(`Answered permission ${args.permission} on session ${args.session} with "${args.response}".`)
  })

  registry.tool("question_reply", {
    description:
      "Answer a pending structured question. A session may answer its own child's question; any other session's question is refused.",
    inputSchema: {
      request: z.string().min(1).describe("Question id from sessions_board."),
      answers: z.array(z.array(z.string())).describe("One array of selected labels per question in the request."),
      ...WORKSPACE_TARGET_SCHEMA,
    },
    access: QUESTION_REPLY_ACCESS,
    sessionIdFromHandler: true,
  }, async (args, ctx, addressed) => {
    const target = attentionWriteTarget(ctx, "question_reply", args)
    if (!target) return mcpToolRefusal(NAME_A_WORKSPACE)
    const server = await ctx.client.server(target)
    const row = (await server.question.list()).data.find((question) => question.id === args.request)
    if (!row) return mcpToolRefusal(`No question ${args.request} is pending here`)
    addressed?.(row.sessionID)
    if (ctx.credential.kind === "runtime") {
      const caller = ctx.credential.sessionId
      const session = await server.session.get({ sessionID: row.sessionID }).catch(() => undefined)
      if (!caller || session?.data.parentID !== caller) {
        throw new McpAccessDenied("own-children-only", `Session ${row.sessionID} is not a child of this session`)
      }
    }
    await server.question.reply({ requestID: args.request, answers: args.answers })
    return toolText(`Answered question ${args.request} on session ${row.sessionID}.`)
  })

  registry.tool("question_reject", {
    description: "Dismiss a pending structured question without answering it. People only.",
    inputSchema: {
      request: z.string().min(1).describe("Question id from sessions_board."),
      ...WORKSPACE_TARGET_SCHEMA,
    },
    access: APPROVE_ACCESS,
    sessionIdFromHandler: true,
  }, async (args, ctx, addressed) => {
    const target = attentionWriteTarget(ctx, "question_reject", args)
    if (!target) return mcpToolRefusal(NAME_A_WORKSPACE)
    const server = await ctx.client.server(target)
    const row = (await server.question.list()).data.find((question) => question.id === args.request)
    if (!row) return mcpToolRefusal(`No question ${args.request} is pending here`)
    addressed?.(row.sessionID)
    await server.question.reject({ requestID: args.request })
    return toolText(`Rejected question ${args.request} on session ${row.sessionID}.`)
  })

  registry.tool("wait_for_attention", {
    description:
      `Wait until something needs you, for at most ${WAIT_FOR_ATTENTION_MAX_MS} ms. Returns as soon as a permission or `
      + "question is pending on any workspace you can see, or the named session's status changes. On a host that supports "
      + "elicitation the pending permission is offered for an answer and applied straight away.",
    inputSchema: {
      timeoutMs: z.number().int().positive().optional().describe(`Upper bound in ms, clamped to ${WAIT_FOR_ATTENTION_MAX_MS}.`),
      session: z.string().optional().describe("Return early when this session's status changes."),
    },
    access: BOARD_ACCESS,
  }, async (args, ctx) => {
    const waitMs = boundedWaitMs(args.timeoutMs)
    const deadline = Date.now() + waitMs
    const { entries, problem } = await boardTargets(ctx.client)
    if (entries.length === 0) return toolText(problem ?? "No workspace is visible to this credential.")
    const mayApprove = toolListed(ctx.credential, APPROVE_ACCESS)
    let baseline: string | undefined
    for (;;) {
      const boards = await Promise.all(entries.map((entry) => readPending(ctx.client, entry)))
      const pending = firstPending(boards)
      if (pending && "permission" in pending) {
        if (ctx.elicit && mayApprove) return elicitPermission(ctx, pending.entry, pending.permission)
        return toolText(`${pending.entry.label}\n  ${permissionLine(pending.permission)} on session ${pending.permission.sessionID}`)
      }
      if (pending) {
        return toolText(`${pending.entry.label}\n  ${questionLine(pending.question)} on session ${pending.question.sessionID}`)
      }
      if (args.session) {
        const status = namedStatus(boards, args.session)
        if (baseline === undefined) baseline = status
        else if (status !== baseline) return toolText(`Session ${args.session} is now ${status}.`)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return toolText(`Nothing was waiting within ${waitMs} ms.`)
      await sleep(Math.min(WAIT_POLL_MS, remaining))
    }
  })
}
