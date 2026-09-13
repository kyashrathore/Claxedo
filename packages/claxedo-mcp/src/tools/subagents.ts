import { z } from "zod"
import {
  harnessEffortRefusal,
  isSessionGroupSlot,
  parseHarnessEffortLevels,
  parseSessionModelGroup,
  type SessionHarness,
  type SessionModelGroup,
} from "@claxedo/agent-runtime-contract"
import { WorkspaceRuntimeClientError, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import type { WorkspaceTarget } from "../client/contract"
import { McpAccessDenied, type McpToolContext } from "../context"
import { McpHttpError, mcpHttpError } from "../http-error"
import { num, oneOf, record, records, text } from "../json"
import { mcpToolRefusal, type McpToolResult } from "../mcp-tool"
import type { ToolRegistry } from "./registry"

/** The self-identifying marker `hostSubagentBinding` looks for in a `create_subagent` result. */
const SUBAGENT_RESULT_KIND = "claxedo.subagent"

/** The runtime refuses the fifth active child with `subagent_child_cap_reached`. */
const MAX_ACTIVE_CHILDREN = 4

/** A `wait` has to answer inside the host's own tool-call timeout, or the host reports a failed call for a child that is running fine. */
const MAX_WAIT_MS = 50_000

const POLL_MIN_MS = 200
const POLL_MAX_MS = 2_000

const ACTIVE_STATUSES = ["pending", "running", "paused"] as const
const TERMINAL_STATUSES = ["completed", "failed", "killed", "interrupted"] as const

/** `permissionCeiling` on the create route is a level, not a mode id; anything else is dropped there. */
const PERMISSION_LEVELS = ["ask", "auto", "full"] as const

/**
 * `RUNTIME_NATIVE_HARNESS_IDS` itself lives beside the runtime's config
 * routes, so importing the value would drag that route module's server
 * dependencies into this endpoint's closure; `satisfies` checks each id
 * against the runtime's own type instead. The runtime stays the validator, so
 * a harness added there but missing here still reaches it as `?nativeHarness=`
 * and an id it does not know comes back as a 400.
 */
const RUNTIME_HARNESSES = ["claude", "codex", "cursor", "pi", "opencode"] as const satisfies readonly RuntimeNativeHarnessId[]

type ChildRow = Readonly<{
  subagentKey: string
  sessionId: string
  status?: string
  label?: string
  role?: string
  attention?: number
  wake?: string
}>

const childLocator = {
  subagentKey: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
}

type ChildLocator = { subagentKey?: string; sessionId?: string }

export function registerSubagentTools(registry: ToolRegistry): void {
  registry.tool("subagent_capabilities", {
    description:
      "Whether this session may run a subagent, which harnesses the runtime can start one on, the permission ceiling a child inherits, and how many children are already active.",
    inputSchema: {},
    access: { audiences: ["runtime"], write: false, scope: "act" },
  }, surfaced(async (_args, ctx) => jsonResult(await capabilities(ctx))))

  registry.tool("create_subagent", {
    description:
      "Start a child session on a chosen harness and give it one task. No history from this session is copied; the child gets the prompt, the optional role line and this session's own instructions. `configuration` runs a slot of this session's model group instead of a harness named here; read the group from subagent_capabilities. `wait` returns the child's answer or times out without cancelling it; `async` returns as soon as the child exists.",
    inputSchema: {
      harness: z.string().min(1).optional().describe(`The harness to run the child on: ${RUNTIME_HARNESSES.join(", ")}. Required unless \`configuration\` names a slot.`),
      configuration: z.string().min(1).optional().describe("A slot of this session's model group; the child runs that slot's harness, model and effort."),
      prompt: z.string().min(1).describe("The whole task. The child cannot see this session."),
      role: z.string().min(1).optional().describe("One line naming what the child is, prefixed to the prompt."),
      model: z.object({ providerID: z.string().min(1), id: z.string().min(1) }).optional(),
      effort: z.string().min(1).optional().describe("The reasoning effort the child runs at. One the harness does not accept for that model is refused, never dropped."),
      mode: z.enum(["async", "wait"]),
      timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional(),
      permissionMode: z.string().min(1).optional().describe("A permission mode at or below this session's; a wider one is refused."),
      clientRequestId: z.string().min(1).optional().describe("Retrying with the same id returns the same child instead of starting another."),
    },
    access: { audiences: ["runtime"], write: true, scope: "act" },
  }, surfaced(createSubagent))

  registry.tool("subagent_status", {
    description: "The current state of one child of this session, with its answer once it has finished.",
    inputSchema: childLocator,
    access: { audiences: ["runtime"], write: false, scope: "act" },
  }, surfaced(async (args: ChildLocator, ctx) => {
    const parent = requireParentSession(ctx)
    const row = await locateChild(ctx, parent, args)
    return bindingResult({
      subagentKey: row.subagentKey,
      sessionId: row.sessionId,
      ...(row.status ? { status: row.status } : {}),
      ...(childSettled(row.status) ? await summaryOf(ctx, row.sessionId) : {}),
    })
  }))

  registry.tool("subagent_list", {
    description: "Every child session this session has started, active or finished.",
    inputSchema: {},
    access: { audiences: ["runtime"], write: false, scope: "act" },
  }, surfaced(async (_args, ctx) => jsonResult(await children(ctx, requireParentSession(ctx)))))

  registry.tool("subagent_cancel", {
    description:
      "Ask a child of this session to stop. The child reaches `killed` when its turn unwinds, so the status here can still be `running`; read it back with subagent_status. A session that is not a child of this one cannot be cancelled here.",
    inputSchema: childLocator,
    access: { audiences: ["runtime"], write: true, scope: "act" },
    sessionIdOf: (args) => args.sessionId,
  }, surfaced(async (args: ChildLocator, ctx) => {
    const parent = requireParentSession(ctx)
    const row = await locateChild(ctx, parent, args)
    await (await ownRuntimeClient(ctx)).session.abort({ sessionID: row.sessionId })
    const snapshot = await findChild(ctx, parent, { subagentKey: row.subagentKey })
    return bindingResult({
      subagentKey: row.subagentKey,
      sessionId: row.sessionId,
      ...(snapshot?.status ? { status: snapshot.status } : {}),
    })
  }))
}

async function createSubagent(
  args: CreateSubagentArgs,
  ctx: McpToolContext,
): Promise<McpToolResult> {
  const parent = requireParentSession(ctx)
  const config = await parentSessionConfig(ctx, parent)
  const choice = resolveChoice(args, config.group)
  await refuseUnsupportedChoice(ctx, choice)
  const child = await createChildSession(ctx, parent, args, choice, childInstructions(config.instructions, choice))
  try {
    await promptChild(ctx, child.sessionId, args.role ? `Role: ${args.role}\n\n${args.prompt}` : args.prompt)
  } catch (error) {
    const refusal = refusalMessage(error)
    if (!refusal) throw error
    return { ...bindingResult({ ...child, error: refusal }), isError: true }
  }
  if (args.mode === "async") {
    const row = await findChild(ctx, parent, { subagentKey: child.subagentKey })
    return bindingResult({ ...child, ...(row?.status ? { status: row.status } : {}) })
  }

  const row = await waitForChild(ctx, parent, child.subagentKey, args.timeoutMs ?? MAX_WAIT_MS)
  const settled = childSettled(row?.status)
  return bindingResult({
    ...child,
    ...(row?.status ? { status: row.status } : {}),
    ...(settled ? await summaryOf(ctx, child.sessionId) : { timedOut: true }),
  })
}

/**
 * `POST /session` with the harness in the query and the child fields in the
 * body. Not `session.create`: the typed client sends every member of its input
 * as the body, and the harness query selects the adapter.
 */
async function createChildSession(
  ctx: McpToolContext,
  parentID: string,
  args: { role?: string; permissionMode?: string; clientRequestId?: string },
  choice: Choice,
  instructions: string,
): Promise<{ subagentKey: string; sessionId: string }> {
  // A credential that declares no level leaves `permissionCeiling` off rather
  // than falling back to `ask` the way a parentless `session_create` must: the
  // route already caps a child at the parent session's own current mode, and
  // naming the floor here would refuse a child under a parent that is wider.
  const ceiling = oneOf(ctx.credential.kind === "runtime" ? ctx.credential.permissionMode : undefined, PERMISSION_LEVELS)
  const body = await postRuntimeJson(ctx, `/session`, harnessQuery(choice.harness), {
    parentID,
    ...(args.role ? { role: args.role, title: args.role } : {}),
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { variant: choice.effort } : {}),
    instructions,
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(args.clientRequestId ? { clientRequestId: args.clientRequestId } : {}),
    ...(ceiling ? { permissionCeiling: ceiling } : {}),
  })
  const row = record(body)
  const sessionId = text(row?.id)
  const subagentKey = text(row?.subagentKey)
  if (!sessionId || !subagentKey) {
    throw new McpHttpError(502, "subagent_row_missing", "The runtime created the child session without a subagent key")
  }
  return { subagentKey, sessionId }
}

type CreateSubagentArgs = {
  harness?: string
  configuration?: string
  prompt: string
  role?: string
  model?: { providerID: string; id: string }
  effort?: string
  mode: "async" | "wait"
  timeoutMs?: number
  permissionMode?: string
  clientRequestId?: string
}

/** What the child will actually run, after a `configuration` slot has been resolved. */
type Choice = {
  harness: SessionHarness
  /** The create route's own model shape, which names the model `id`. */
  model?: { providerID: string; id: string }
  effort?: string
  slot?: string
}

type ParentSessionConfig = {
  instructions?: string
  group: SessionModelGroup
}

const harnessQuery = (harness: SessionHarness): Record<string, string> =>
  harness.access === "connection" ? { connectionId: harness.id } : { nativeHarness: harness.id }

const describeChoice = (choice: Choice): string =>
  `${choice.harness.id}${choice.model ? `, ${choice.model.providerID}/${choice.model.id}` : ""}, effort: ${choice.effort ?? "not set"}`

/**
 * The slot's harness, model and effort, or the caller's own three fields. A
 * slot and an explicit field that disagree are refused rather than ranked:
 * either answer would run a configuration nobody asked for.
 */
function resolveChoice(args: CreateSubagentArgs, group: SessionModelGroup): Choice {
  if (!args.configuration) {
    if (!args.harness) {
      throw new McpHttpError(400, "subagent_harness_required", "Name a harness, or a configuration from this session's model group")
    }
    return {
      harness: { id: args.harness, access: "native" },
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
    }
  }
  const entry = isSessionGroupSlot(args.configuration) ? group[args.configuration] : undefined
  if (!entry) {
    const slots = Object.keys(group)
    throw new McpHttpError(400, "subagent_configuration_unknown", slots.length > 0
      ? `This session's model group has no "${args.configuration}" configuration; it has ${slots.join(", ")}`
      : `This session was started with no model group, so "${args.configuration}" names nothing`)
  }
  contradiction("harness", args.harness, entry.harness.id, args.configuration)
  contradiction("effort", args.effort, entry.effort, args.configuration)
  if (args.model) {
    contradiction("model", `${args.model.providerID}/${args.model.id}`, `${entry.model.providerID}/${entry.model.modelID}`, args.configuration)
  }
  return {
    harness: entry.harness,
    model: { providerID: entry.model.providerID, id: entry.model.modelID },
    ...(entry.effort ? { effort: entry.effort } : {}),
    slot: args.configuration,
  }
}

function contradiction(field: string, requested: string | undefined, resolved: string | undefined, slot: string): void {
  if (!requested || requested === resolved) return
  throw new McpHttpError(400, "subagent_configuration_contradicted",
    `The ${slot} configuration runs ${field} ${resolved ?? "unset"}, not ${requested}; drop one of the two`)
}

/**
 * What the harness registered for this workspace says about the choice. An
 * unregistered harness answers through the capability read's own refusal, so
 * only the model and the effort are judged here.
 */
async function refuseUnsupportedChoice(ctx: McpToolContext, choice: Choice): Promise<void> {
  const body = record(await getRuntimeJson(ctx, "/session/capabilities", harnessQuery(choice.harness)))
  const selection = record(body?.modelSelection)
  if (choice.model && selection?.status === "unsupported") {
    throw new McpHttpError(400, "subagent_model_unavailable",
      `The ${choice.harness.id} harness selects its own model and would ignore ${choice.model.providerID}/${choice.model.id}`)
  }
  const chosen = choice.model
  const offered = records(selection?.models)
  if (chosen && offered.length > 0
    && !offered.some((model) => model.providerId === chosen.providerID && model.modelId === chosen.id)) {
    throw new McpHttpError(400, "subagent_model_unavailable",
      `${chosen.providerID}/${chosen.id} is not offered by the ${choice.harness.id} harness here`)
  }
  const refusal = harnessEffortRefusal({
    harness: choice.harness.id,
    catalog: parseHarnessEffortLevels(body?.effortLevels),
    modelID: choice.model?.id,
    effort: choice.effort,
  })
  if (refusal) throw new McpHttpError(400, "subagent_effort_unsupported", refusal)
}

async function parentSessionConfig(ctx: McpToolContext, parent: string): Promise<ParentSessionConfig> {
  const body = record(await getRuntimeJson(ctx, `/session/${encodeURIComponent(parent)}/config`, {}))
  const instructions = text(body?.instructions)
  if (body?.group === undefined || body.group === null) {
    return { ...(instructions ? { instructions } : {}), group: {} }
  }
  const parsed = parseSessionModelGroup(body.group)
  // The runtime wrote this group through this same parser, so a field refused
  // here is a corrupt row rather than a caller mistake.
  if ("field" in parsed) {
    throw new McpHttpError(502, "session_group_unreadable",
      `This session's model group cannot be read: ${parsed.field} ${parsed.message}`)
  }
  return { ...(instructions ? { instructions } : {}), group: parsed.group }
}

/**
 * The parent's own instruction block, then what the child cannot otherwise
 * know: which configuration it is running.
 *
 * A block over the runtime's cap is refused there by byte count rather than
 * trimmed here — silently dropping the tail of what the parent was told is the
 * one outcome worse than the create failing with a reason.
 */
function childInstructions(parent: string | undefined, choice: Choice): string {
  return [
    ...(parent ? [parent] : []),
    [
      "## This subagent",
      `Started by another session${choice.slot ? ` as its ${choice.slot} configuration` : ""}: ${describeChoice(choice)}.`,
      "You run under that session's permissions and its workspace's own skills and plugins, and you cannot start subagents of your own.",
    ].join("\n"),
  ].join("\n\n")
}

/**
 * The message id is derived from the child so a create retried under the same
 * `clientRequestId` — which resolves to the same child — is deduplicated by
 * the runtime rather than starting a second turn. The `msg_` prefix is a hard
 * constraint of the OpenCode engine — `Session.Message.ID` refuses every other
 * shape — and this is the id the child's own first turn is admitted under.
 */
async function promptChild(ctx: McpToolContext, sessionId: string, prompt: string): Promise<void> {
  await (await ownRuntimeClient(ctx)).session.promptAsync({
    sessionID: sessionId,
    messageID: `msg_subagent_${sessionId}`,
    parts: [{ type: "text", text: prompt }],
  })
}

/**
 * A runtime that declares no default harness still starts a child on the
 * harness `create_subagent` names, so the answer is the harness list with that
 * state named on every row rather than a failed call.
 */
async function runtimeDefaultHarness(ctx: McpToolContext) {
  try {
    const { harness, effortLevels } = (await (await ownRuntimeClient(ctx)).session.harnessCapabilities()).data
    return { harness, ...(effortLevels ? { effortLevels } : {}) }
  } catch (error) {
    if (error instanceof WorkspaceRuntimeClientError && error.code === "workspace_harness_not_configured") {
      return { unconfigured: error.message }
    }
    throw error
  }
}

async function capabilities(ctx: McpToolContext) {
  const parent = ctx.credential.kind === "runtime" ? ctx.credential.sessionId : undefined
  const permissionCeiling = ctx.credential.kind === "runtime" ? ctx.credential.permissionMode : undefined
  const runtime = await runtimeDefaultHarness(ctx)
  const runtimeHarness = "harness" in runtime ? runtime.harness : undefined
  const harnesses = RUNTIME_HARNESSES.map((id) => id === runtimeHarness
    ? { id, status: "ready" as const }
    : {
        id,
        status: "unverified" as const,
        reason: runtimeHarness
          ? `This runtime serves ${runtimeHarness}; whether it can start a ${id} child is answered by the create itself`
          : `${"unconfigured" in runtime ? runtime.unconfigured : ""}; whether it can start a ${id} child is answered by the create itself`,
      })
  const shared = {
    ...(runtimeHarness ? { runtimeHarness } : {}),
    // Only this runtime's own harness answers a capability read without a
    // harness named, so the effort catalog here is that harness's; a child on
    // another one has its effort judged by the create's own read.
    ...("effortLevels" in runtime && runtime.effortLevels ? { effortLevels: runtime.effortLevels } : {}),
    harnesses,
    maxActiveChildren: MAX_ACTIVE_CHILDREN,
    waitTimeoutMaxMs: MAX_WAIT_MS,
  }

  if (!parent) {
    return { canSpawn: false, reason: "This credential names no session, so a child would have no parent", ...shared }
  }
  const session = (await (await ownRuntimeClient(ctx)).session.get({ sessionID: parent })).data
  if (text(session.parentID)) {
    return { canSpawn: false, reason: "This session is itself a subagent, and a subagent cannot start subagents", parentSessionId: parent, ...shared }
  }
  const rows = await children(ctx, parent)
  const activeChildren = rows.filter((row) => childActive(row.status)).length
  const group = (await parentSessionConfig(ctx, parent)).group
  return {
    canSpawn: activeChildren < MAX_ACTIVE_CHILDREN,
    ...(activeChildren < MAX_ACTIVE_CHILDREN
      ? {}
      : { reason: `This session already has ${activeChildren} active children` }),
    parentSessionId: parent,
    ...(permissionCeiling ? { permissionCeiling } : {}),
    activeChildren,
    // The slot keys `create_subagent`'s `configuration` accepts; a session
    // started outside a model group reports the empty set.
    configurations: group,
    ...shared,
  }
}

async function waitForChild(ctx: McpToolContext, parent: string, subagentKey: string, timeoutMs: number) {
  const deadline = Date.now() + Math.min(timeoutMs, MAX_WAIT_MS)
  let interval = POLL_MIN_MS
  let row = await findChild(ctx, parent, { subagentKey })
  while (!childSettled(row?.status)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)))
    interval = Math.min(interval * 2, POLL_MAX_MS)
    row = await findChild(ctx, parent, { subagentKey })
  }
  return row
}

async function summaryOf(ctx: McpToolContext, sessionId: string): Promise<{ summary?: string }> {
  const page = await (await ownRuntimeClient(ctx)).session.messages({ sessionID: sessionId, view: "latest-turn" })
  for (const message of [...page.data].reverse()) {
    if (message.info.role !== "assistant") continue
    const summary = text(message.parts.map((part) => part.type === "text" ? part.text : "").join("").trim())
    if (summary) return { summary }
  }
  return {}
}

async function children(ctx: McpToolContext, parent: string): Promise<ChildRow[]> {
  const rows = await (await ownRuntimeClient(ctx)).session.subagents({ sessionID: parent })
  return rows.data.flatMap((row) => childRow(row) ?? [])
}

async function findChild(ctx: McpToolContext, parent: string, locator: ChildLocator) {
  return (await children(ctx, parent)).find((row) =>
    (locator.subagentKey === undefined || row.subagentKey === locator.subagentKey)
    && (locator.sessionId === undefined || row.sessionId === locator.sessionId))
}

async function locateChild(ctx: McpToolContext, parent: string, locator: ChildLocator): Promise<ChildRow> {
  if (!locator.subagentKey && !locator.sessionId) {
    throw new McpAccessDenied("own-children-only", "Name the child by subagentKey or sessionId")
  }
  const row = await findChild(ctx, parent, locator)
  if (!row) {
    throw new McpAccessDenied(
      "own-children-only",
      `${locator.sessionId ?? locator.subagentKey} is not a child of this session`,
    )
  }
  return row
}

/** Only the rows this runtime owns: a harness's own subagents have no Claxedo session to address. */
function childRow(value: unknown): ChildRow | undefined {
  const row = record(value)
  if (row?.providerKind !== "claxedo") return undefined
  const subagentKey = text(row.subagentKey)
  const sessionId = text(row.childSessionId)
  if (!subagentKey || !sessionId) return undefined
  const status = text(row.status)
  const label = text(row.label)
  const role = text(row.subagentType)
  const attention = num(row.attention)
  const wake = text(row.wake)
  return {
    subagentKey,
    sessionId,
    ...(status ? { status } : {}),
    ...(label ? { label } : {}),
    ...(role ? { role } : {}),
    ...(attention !== undefined ? { attention } : {}),
    ...(wake ? { wake } : {}),
  }
}

const childActive = (status: string | undefined) => (ACTIVE_STATUSES as readonly string[]).includes(status ?? "pending")
const childSettled = (status: string | undefined) => (TERMINAL_STATUSES as readonly string[]).includes(status ?? "")

function requireParentSession(ctx: McpToolContext): string {
  const sessionId = ctx.credential.kind === "runtime" ? ctx.credential.sessionId : undefined
  if (!sessionId) {
    throw new McpAccessDenied("audience", "A subagent tool acts for the session that called it, and this credential names none")
  }
  return sessionId
}

const ownWorkspaceTarget = (ctx: McpToolContext): WorkspaceTarget => ctx.client.ownWorkspace ?? {}

const ownRuntimeClient = (ctx: McpToolContext): Promise<WorkspaceRuntimeClient> => ctx.client.server(ownWorkspaceTarget(ctx))

const postRuntimeJson = (ctx: McpToolContext, path: string, query: Record<string, string>, body: unknown) =>
  ownWorkspaceJson(ctx, path, query, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const getRuntimeJson = (ctx: McpToolContext, path: string, query: Record<string, string>) =>
  ownWorkspaceJson(ctx, path, query, { headers: { accept: "application/json" } })

async function ownWorkspaceJson(
  ctx: McpToolContext,
  path: string,
  query: Record<string, string>,
  init: RequestInit,
): Promise<unknown> {
  const resolved = await ctx.client.resolveTarget(ownWorkspaceTarget(ctx))
  const runtime = await ctx.client.runtime(ownWorkspaceTarget(ctx))
  const search = new URLSearchParams(query)
  if (resolved.directory) search.set("directory", resolved.directory)
  if (resolved.workspaceId) search.set("workspace", resolved.workspaceId)
  const response = await runtime(`${path}?${search.toString()}`, init)
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw mcpHttpError(response.status, payload)
  return payload
}

/**
 * The parent's harness reads this block back out of the tool result and admits
 * it as an observation on the child's own subagent row, so `status` has to be
 * one the runtime just reported; a guessed one is written to the row as fact.
 * Omitting it leaves the row's status alone.
 */
function bindingResult(binding: Record<string, unknown> & { subagentKey: string; sessionId: string }): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ kind: SUBAGENT_RESULT_KIND, ...binding }) }] }
}

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function refusalMessage(error: unknown): string | undefined {
  if (error instanceof WorkspaceRuntimeClientError) return `${error.code}: ${error.message}`
  if (error instanceof McpHttpError) return `${error.code ?? `http_${error.status}`}: ${error.message}`
  return undefined
}

/** A refusal the runtime named stays named; anything else is a fault and keeps its stack. */
function surfaced<Args>(
  handler: (args: Args, ctx: McpToolContext) => Promise<McpToolResult>,
): (args: Args, ctx: McpToolContext) => Promise<McpToolResult> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx)
    } catch (error) {
      const refusal = refusalMessage(error)
      if (!refusal) throw error
      return mcpToolRefusal(refusal)
    }
  }
}
