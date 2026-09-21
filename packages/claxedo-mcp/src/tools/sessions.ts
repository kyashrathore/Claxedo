/**
 * Sessions: create one anywhere the account can reach, find the ones that
 * exist, read them, and drive them.
 *
 * A placement decides which executor creates the session, and that is the only
 * branch in this group: everything after it is the same typed runtime client
 * pointed at a resolved target.
 */
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { workspaceRuntimeClientError, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import { McpAccessDenied, type McpToolContext } from "../context"
import type { McpToolResult } from "../mcp-tool"
import type { WorkspaceSummary, WorkspaceTarget } from "../client/contract"
import type { ToolRegistrar } from "./registry"
import { runtimeToolAccess } from "./inventory"
import { assertSessionReach } from "./session-reach"
import { assertWritableTarget, targetScope, toolJson, toolTarget, WORKSPACE_TARGET_SCHEMA, type WorkspaceTargetArgs } from "./target"

/** The harnesses `?nativeHarness=` names; `satisfies` refuses one the runtime does not have. */
const NATIVE_HARNESSES = ["claude", "codex", "cursor", "pi", "opencode"] as const satisfies readonly RuntimeNativeHarnessId[]

/**
 * `permissionCeiling` on `POST /session`. A session created from inside a
 * session caps at `ask`: the runtime credential carries no mode of its own,
 * and `ask` is the direction `permissionModeLevel` takes for an unranked mode.
 * A human credential names no ceiling — its ceiling is the workspace's own
 * policy, and naming one here would let a scope-limited token widen it.
 */
function permissionCeiling(ctx: McpToolContext): "ask" | undefined {
  return ctx.credential.kind === "runtime" ? "ask" : undefined
}

const SESSION_ARG = {
  session: z.string().trim().min(1).describe("Session id."),
} as const

/**
 * Every member is strict. An open object accepts the other members' bodies and
 * strips them, so a union of open members resolves every placement to its first
 * one and a worktree or cloud request silently becomes a plain session.
 */
const placementSchema = z
  .union([
    z.strictObject({ workspace: z.strictObject({}).optional() }).describe("Create in the target workspace as it is."),
    z.strictObject({ worktree: z.strictObject({ name: z.string().trim().min(1).optional().describe("Worktree name. The runtime picks one when omitted.") }) }),
    z.strictObject({
      cloud: z.strictObject({
        repoUrl: z.string().trim().min(1).describe("Clone URL for the new cloud workspace."),
        name: z.string().trim().min(1).optional().describe("Display name for the new workspace."),
      }),
    }),
  ])
  .describe("Where the session runs: the workspace itself, a new git worktree beside it, or a new cloud workspace.")

type Placement = z.infer<typeof placementSchema>

/**
 * Cancel whatever turn the session is running now, under the identity the
 * owner reports for it. The target comes from inspection rather than from the
 * caller: a cancellation naming only the session reaches whichever turn is
 * running when it lands, which after a replacement is a different one.
 */
export async function cancelSessionTurn(
  server: WorkspaceRuntimeClient,
  scope: { workspace?: string; directory?: string },
  sessionId: string,
): Promise<RecoveryOutcome> {
  const inspected = await server.session.recovery.inspect({ sessionID: sessionId, ...scope })
  const target = inspected.data.target
  if (!target) {
    return { kind: "refused", refusal: { kind: "generation_conflict", message: `Session ${sessionId} is not running a turn` } }
  }
  const submitted = await server.session.recovery.submit({
    sessionID: sessionId,
    ...scope,
    request: {
      requestId: randomUUID(),
      action: "cancel_turn",
      target,
      scopeRevision: target.ownerGeneration,
      attempt: 1,
    },
  })
  return submitted.data
}

/** An operation that reached its postcondition is the only non-error answer. */
export function recoveryResult(payload: unknown, outcome: RecoveryOutcome): McpToolResult {
  const succeeded = outcome.kind === "operation" && outcome.operation.state === "succeeded"
  return { ...toolJson(payload), ...(succeeded ? {} : { isError: true }) }
}

export function registerSessionTools(registry: ToolRegistrar) {
  registry.tool(
    "session_create",
    {
      description:
        "Start a Claxedo session on a chosen harness, in the current workspace, in a new git worktree beside it, or on a new cloud workspace.",
      inputSchema: {
        ...WORKSPACE_TARGET_SCHEMA,
        harness: z.enum(NATIVE_HARNESSES).optional().describe("Harness to run the session on. Defaults to the workspace's own default."),
        prompt: z.string().trim().min(1).optional().describe("First turn to send once the session exists."),
        title: z.string().trim().min(1).optional().describe("Session title."),
        placement: placementSchema.optional(),
      },
      access: runtimeToolAccess("session_create", { audiences: ["runtime", "user"], scope: "act" }),
      sessionIdFromHandler: true,
    },
    async (args, ctx, addressed) => {
      const placed = await placeSession(ctx, args, args.placement)
      const created = await createSession(ctx, placed.target, {
        ...(args.harness ? { harness: args.harness } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(placed.target.directory ? { directory: placed.target.directory } : {}),
      })
      addressed?.(created.id)
      // The session this turn goes to is the one this call just created, which
      // `session_send`'s kinship rule would refuse: it is neither the caller
      // nor a child of it.
      if (args.prompt) await promptSession(await ctx.client.server(placed.target), placed.target, created.id, args.prompt)
      return toolJson({ ...created, ...placed.detail, prompted: Boolean(args.prompt) })
    },
  )

  registry.tool(
    "sessions_list",
    {
      description:
        "List root sessions with their live status across every workspace the account can see. A workspace whose machine is offline reports that instead of a stale copy.",
      inputSchema: {
        workspace: WORKSPACE_TARGET_SCHEMA.workspace.describe("Only this workspace. Defaults to every workspace the account can see."),
        limit: z.number().int().min(1).max(200).optional().describe("Sessions per workspace. Defaults to 50."),
      },
      access: runtimeToolAccess("sessions_list", { audiences: ["runtime", "user"], scope: "read" }),
    },
    async (args, ctx) => toolJson({ workspaces: await listSessions(ctx, args.workspace, args.limit ?? 50) }),
  )

  registry.tool(
    "session_get",
    {
      description: "Read one session's metadata and harness configuration.",
      inputSchema: { ...SESSION_ARG, ...WORKSPACE_TARGET_SCHEMA },
      access: runtimeToolAccess("session_get", { audiences: ["runtime", "user"], scope: "read" }),
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      const server = await ctx.client.server(target)
      const input = { sessionID: args.session, ...targetScope(target) }
      const [session, config] = await Promise.all([server.session.get(input), server.session.config.get(input)])
      return toolJson({ session: session.data, config: config.data })
    },
  )

  registry.tool(
    "session_transcript",
    {
      description: "Read a page of one session's transcript, newest turn first by default.",
      inputSchema: {
        ...SESSION_ARG,
        ...WORKSPACE_TARGET_SCHEMA,
        view: z.enum(["latest-turn", "latest-surface"]).optional().describe("A whole turn or the latest surface. Defaults to latest-turn."),
        limit: z.number().int().min(1).max(500).optional().describe("Messages to read instead of a view."),
        before: z.string().trim().min(1).optional().describe("Cursor from a previous page's nextCursor."),
      },
      access: runtimeToolAccess("session_transcript", { audiences: ["runtime", "user"], scope: "read" }),
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      const server = await ctx.client.server(target)
      const page = args.limit === undefined && args.before === undefined
        ? { view: args.view ?? ("latest-turn" as const) }
        : { limit: args.limit ?? 50, ...(args.before ? { before: args.before } : {}) }
      const read = await server.session.messages({ sessionID: args.session, ...targetScope(target), ...page })
      // The route answers with the messages alone and puts the cursor on a
      // header, so a page read straight from the body cannot say how to ask
      // for the next one.
      const nextCursor = read.response.headers.get("X-Next-Cursor")
      return toolJson({ messages: read.data, ...(nextCursor ? { nextCursor } : {}) })
    },
  )

  registry.tool(
    "session_send",
    {
      description:
        "Send a turn to a session. Returns as soon as the runtime admits the turn; read the answer with session_transcript. "
        + "Inside a session, this reaches that session and the children it started, and no other.",
      inputSchema: { ...SESSION_ARG, ...WORKSPACE_TARGET_SCHEMA, text: z.string().trim().min(1).describe("The prompt to send.") },
      access: runtimeToolAccess("session_send", { audiences: ["runtime", "user"], scope: "act" }),
      sessionIdOf: (args) => args.session,
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      assertWritableTarget(ctx, "session_send", target)
      const server = await ctx.client.server(target)
      await assertSessionReach({ ctx, tool: "session_send", server, target, session: args.session, reach: "itself-or-own-children" })
      return toolJson({ session: args.session, admitted: await promptSession(server, target, args.session, args.text) })
    },
  )

  registry.tool(
    "session_cancel_turn",
    {
      description:
        "Cancel the turn a session is running, and report what actually happened to it: whether execution stopped, whether the turn's resources were cleared, and whether that was recorded. Inside a session, this reaches that session and the children it started, and no other.",
      inputSchema: { ...SESSION_ARG, ...WORKSPACE_TARGET_SCHEMA },
      access: runtimeToolAccess("session_cancel_turn", { audiences: ["runtime", "user"], scope: "act" }),
      sessionIdOf: (args) => args.session,
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      assertWritableTarget(ctx, "session_cancel_turn", target)
      const server = await ctx.client.server(target)
      await assertSessionReach({ ctx, tool: "session_cancel_turn", server, target, session: args.session, reach: "itself-or-own-children" })
      const outcome = await cancelSessionTurn(server, targetScope(target), args.session)
      return recoveryResult({ session: args.session, cancellation: outcome }, outcome)
    },
  )

  registry.tool(
    "session_handoff",
    {
      description: "Move a session to another harness. The runtime renders the conversation so far as the new harness's opening context.",
      inputSchema: { ...SESSION_ARG, ...WORKSPACE_TARGET_SCHEMA, harness: z.enum(NATIVE_HARNESSES).describe("Harness to hand the session to.") },
      access: runtimeToolAccess("session_handoff", { audiences: ["user"], scope: "act" }),
      sessionIdOf: (args) => args.session,
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      const server = await ctx.client.server(target)
      const config = await server.session.config.update({
        sessionID: args.session,
        ...targetScope(target),
        harness: { id: args.harness, access: "native" },
      })
      return toolJson({ session: args.session, config: config.data })
    },
  )

  registry.tool(
    "session_rename",
    {
      description: "Retitle a session.",
      inputSchema: { ...SESSION_ARG, ...WORKSPACE_TARGET_SCHEMA, title: z.string().trim().min(1).describe("New title.") },
      access: runtimeToolAccess("session_rename", { audiences: ["user"], scope: "act" }),
      sessionIdOf: (args) => args.session,
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      const server = await ctx.client.server(target)
      const session = await server.session.update({ sessionID: args.session, ...targetScope(target), title: args.title })
      return toolJson(session.data)
    },
  )

  registry.tool(
    "session_delete",
    {
      description: "Delete a session and its transcript. This cannot be undone.",
      inputSchema: { ...SESSION_ARG, ...WORKSPACE_TARGET_SCHEMA },
      access: runtimeToolAccess("session_delete", { audiences: ["user"], scope: "admin", destructive: true }),
      sessionIdOf: (args) => args.session,
    },
    async (args, ctx) => {
      const target = toolTarget(ctx, args)
      const server = await ctx.client.server(target)
      const deleted = await server.session.delete({ sessionID: args.session, ...targetScope(target) })
      return toolJson({ session: args.session, deleted: deleted.data })
    },
  )
}

/**
 * `POST /session` through the resolved runtime rather than the typed client:
 * the harness is chosen with `?nativeHarness=`, which the typed client's
 * session member has no argument for, and a body `harness` field is refused
 * 400 on purpose.
 */
async function createSession(
  ctx: McpToolContext,
  target: WorkspaceTarget,
  input: Readonly<{ harness?: string; title?: string; directory?: string }>,
) {
  const runtime = await ctx.client.runtime(target)
  const ceiling = permissionCeiling(ctx)
  const query = new URLSearchParams()
  if (input.harness) query.set("nativeHarness", input.harness)
  if (input.directory) query.set("directory", input.directory)
  else if (target.directory) query.set("directory", target.directory)
  if (target.workspaceId) query.set("workspace", target.workspaceId)
  const response = await runtime(`/session?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.title ? { title: input.title } : {}),
      ...(ceiling ? { permissionCeiling: ceiling } : {}),
    }),
  })
  if (!response.ok) throw await workspaceRuntimeClientError("session.create", response)
  const body: unknown = await response.json()
  const id = asRecord(body)?.id
  if (typeof id !== "string") throw new Error("The runtime created a session without an id")
  return { id, session: body, ...(ceiling ? { permissionCeiling: ceiling } : {}) }
}

/** The turn is admitted when the call returns; it runs on after the response. */
async function promptSession(server: WorkspaceRuntimeClient, target: WorkspaceTarget, sessionId: string, text: string) {
  await server.session.promptAsync({ sessionID: sessionId, ...targetScope(target), parts: [{ type: "text", text }] })
  return true
}

type PlacedSession = Readonly<{ target: WorkspaceTarget; detail: Record<string, unknown> }>

async function placeSession(ctx: McpToolContext, args: WorkspaceTargetArgs, placement: Placement | undefined): Promise<PlacedSession> {
  if (placement && "cloud" in placement) return placeOnCloud(ctx, placement.cloud)
  const target = toolTarget(ctx, args)
  assertWritableTarget(ctx, "session_create", target)
  if (!placement || !("worktree" in placement)) return { target, detail: {} }
  return placeInWorktree(ctx, target, placement.worktree)
}

/**
 * A worktree is the local server's own route, not a runtime one: it registers
 * a second workspace directory beside the project's checkout, and the session
 * is created in the directory it answers with.
 */
async function placeInWorktree(
  ctx: McpToolContext,
  target: WorkspaceTarget,
  worktree: Readonly<{ name?: string }>,
): Promise<PlacedSession> {
  const runtime = await ctx.client.runtime(target)
  const query = new URLSearchParams()
  if (target.workspaceId) query.set("workspaceId", target.workspaceId)
  if (target.directory) query.set("directory", target.directory)
  const response = await runtime(`/experimental/worktree?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(worktree.name ? { name: worktree.name } : {}),
  })
  if (!response.ok) throw await workspaceRuntimeClientError("worktree.create", response)
  const created = asRecord(await response.json())
  const directory = created?.directory
  if (typeof directory !== "string") throw new Error("The worktree route answered without a directory")
  return { target: { ...target, directory }, detail: { worktree: created } }
}

/**
 * Cloud placement creates the workspace at the control plane and then reaches
 * its runtime through the relay; the client's connection handshake is what
 * waits out provisioning, so nothing here polls.
 */
async function placeOnCloud(
  ctx: McpToolContext,
  cloud: Readonly<{ repoUrl: string; name?: string }>,
): Promise<PlacedSession> {
  if (ctx.credential.kind === "runtime" && !ctx.credential.crossMachineWrites) {
    throw new McpAccessDenied(
      "cross-machine",
      "Creating a cloud workspace from inside a session needs the account setting that lets agents act on other machines",
    )
  }
  const controlPlane = ctx.client.controlPlane
  if (!controlPlane) throw new Error("Cloud placement needs an account credential and none is reachable here")
  const response = await controlPlane("/api/workspace/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: cloud.repoUrl, ...(cloud.name ? { workspaceName: cloud.name } : {}) }),
  })
  if (!response.ok) throw await workspaceRuntimeClientError("workspace.create", response)
  const created = asRecord(await response.json())
  const workspaceId = created?.workspaceId
  if (typeof workspaceId !== "string") throw new Error("The control plane created a workspace without an id")
  const directory = typeof created?.directory === "string" ? created.directory : undefined
  return {
    target: { workspaceId, ...(directory ? { directory } : {}) },
    detail: { cloudWorkspace: { id: workspaceId, ...(directory ? { directory } : {}) } },
  }
}

type WorkspaceSessions = Readonly<{
  workspace: string
  name?: string
  kind?: string
  /** Absent when the workspace answered; otherwise why it did not. */
  unavailable?: string
  sessions?: unknown[]
}>

async function listSessions(ctx: McpToolContext, only: string | undefined, limit: number): Promise<readonly WorkspaceSessions[]> {
  const rows = await reachableWorkspaces(ctx, only)
  return await Promise.all(rows.map((row) => workspaceSessions(ctx, row, limit)))
}

/**
 * Which workspaces the list spans. Without an account credential the client
 * can only reach the one runtime in its own process, so the answer names that
 * workspace rather than pretending the account has none.
 */
async function reachableWorkspaces(ctx: McpToolContext, only: string | undefined): Promise<readonly WorkspaceSummary[]> {
  const own = ctx.credential.kind === "runtime" ? ctx.credential.workspaceId : ctx.client.ownWorkspace?.workspaceId
  if (!ctx.client.controlPlane) {
    const id = only ?? own
    return id ? [{ id }] : []
  }
  const all = await ctx.client.workspaces()
  return only ? all.filter((workspace) => workspace.id === only) : all
}

async function workspaceSessions(ctx: McpToolContext, workspace: WorkspaceSummary, limit: number): Promise<WorkspaceSessions> {
  const row = {
    workspace: workspace.id,
    ...(workspace.name ? { name: workspace.name } : {}),
    ...(workspace.host ? { host: workspace.host } : {}),
  }
  if (workspace.machineOnline === false) return { ...row, unavailable: "machine offline" }
  try {
    const server = await ctx.client.server({ workspaceId: workspace.id })
    return { ...row, sessions: await rootSessions(server, workspace.id, limit) }
  } catch (error) {
    return { ...row, unavailable: error instanceof Error ? error.message : String(error) }
  }
}

async function rootSessions(server: WorkspaceRuntimeClient, workspaceId: string, limit: number) {
  const [summaries, status] = await Promise.all([
    server.session.summaries({ workspace: workspaceId, roots: true, limit }),
    server.session.status({ workspace: workspaceId }),
  ])
  return summaries.data.map((session) => {
    const id = session.id
    return { ...session, ...(typeof id === "string" && status.data[id] ? { status: status.data[id] } : {}) }
  })
}
