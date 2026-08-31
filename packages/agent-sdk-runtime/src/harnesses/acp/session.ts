import type {
  ClientContext,
  ContentBlock,
  InitializeResponse,
  McpServer,
  PromptCapabilities,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionMode,
} from "@agentclientprotocol/sdk"
import { methods } from "@agentclientprotocol/sdk"
import type { PromptInput } from "../../index"
import type { AgentPermissionMode, AgentPermissionModeState } from "../../adapter-contract"
import { GOAL_OPTIONAL_FIELDS, type GoalAction, type GoalCapabilities, type GoalOptionalField } from "../../capabilities"

export const ACP_GOAL_METHODS = {
  read: "session/goal/get",
  start: "session/goal/start",
  stop: "session/goal/stop",
  pause: "session/goal/pause",
  resume: "session/goal/resume",
  delete: "session/goal/delete",
} as const

export type ACPGoalExtension = {
  version: 1
  methods: ReadonlySet<string>
  actions: readonly GoalAction[]
  optionalFields: readonly GoalOptionalField[]
}

type Caps = InitializeResponse["agentCapabilities"] | null | undefined
type Meta = {
  configOptions?: SessionConfigOption[] | null
  modes?: unknown
}

function rec(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

function str(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

export function goalExtension(meta: unknown): ACPGoalExtension | null {
  const root = rec(meta)
  const goal = rec(root?.goal)
  if (goal?.version !== 1 || !Array.isArray(goal.methods) || !Array.isArray(goal.actions)) return null
  const methods = new Set(goal.methods.filter((item): item is string => typeof item === "string"))
  if (
    !methods.has(ACP_GOAL_METHODS.read)
    || !methods.has(ACP_GOAL_METHODS.start)
    || !methods.has(ACP_GOAL_METHODS.stop)
  ) return null
  const advertised = new Set(goal.actions.filter((item): item is string => typeof item === "string"))
  const actions: GoalAction[] = []
  const reversible = advertised.has("pause")
    && advertised.has("resume")
    && methods.has(ACP_GOAL_METHODS.pause)
    && methods.has(ACP_GOAL_METHODS.resume)
  if (reversible) actions.push("pause", "resume")
  if (advertised.has("delete") && methods.has(ACP_GOAL_METHODS.delete)) actions.push("delete")
  const knownOptional = new Set<GoalOptionalField>(GOAL_OPTIONAL_FIELDS)
  const optionalFields = Array.isArray(goal.optionalFields)
    ? goal.optionalFields.filter((item): item is GoalOptionalField => typeof item === "string" && knownOptional.has(item as GoalOptionalField))
    : []
  return { version: 1, methods, actions, optionalFields }
}

export function goalExtensionCapabilities(extension: ACPGoalExtension | null): GoalCapabilities {
  return extension
    ? {
        implemented: true,
        available: true,
        actions: extension.actions,
        recovery: "reconcile",
        optionalFields: extension.optionalFields,
      }
    : {
        implemented: false,
        available: false,
        unavailableReason: "ACP agent did not negotiate the Goal extension",
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      }
}

function flat(options: SessionConfigSelectOption[] | SessionConfigSelectGroup[]) {
  const first = options[0] as Record<string, unknown> | undefined
  if (!first) return [] as SessionConfigSelectOption[]
  if ("group" in first) {
    return (options as SessionConfigSelectGroup[]).flatMap((item) => item.options)
  }
  return options as SessionConfigSelectOption[]
}

function pick(cfg: SessionConfigOption[] | null, kind: "mode" | "model" | "thought_level") {
  return cfg?.find((item) => item.type === "select" && (item.category === kind || item.id === kind)) ?? null
}

function match(opt: SessionConfigOption | null, ids: string[]) {
  if (!opt || opt.type !== "select") return null
  const set = new Set(ids)
  return flat(opt.options ?? []).find((item) => set.has(item.value as string))?.value as string | undefined
}

function currentValue(opt: SessionConfigOption | null): string | undefined {
  if (!opt || opt.type !== "select") return undefined
  return typeof opt.currentValue === "string" ? opt.currentValue : undefined
}

export type ACPState = {
  caps: Caps
  prompt: PromptCapabilities | null | undefined
  cfg: SessionConfigOption[] | null
  /**
   * Modes the agent advertised, as protocol `SessionMode` objects. Empty = modes
   * not supported.
   *
   * The full object is kept, not just the id, because `SessionModeId` is
   * deliberately an open `string` in the spec — there is no enumeration to match
   * against, so clients use the agent's own `name` and `description`.
   *
   * This channel is GENERIC and serves two unrelated purposes in this repo:
   * `sync` below matches AGENT names against these ids, while Claxedo's
   * permission-mode picker matches its own policy intents against them. So this
   * keeps the protocol's term — an advertised session mode is not necessarily a
   * permission mode.
   */
  modes: SessionMode[]
  /**
   * The agent's OWN report of which mode is active, from the same payload as
   * `modes`. Kept rather than inferred from the last write because an agent may
   * clamp the selection when its available modes change.
   */
  currentModeId?: string
}

export type ACPConn = ClientContext

export function init(caps: Caps): ACPState {
  return {
    caps,
    prompt: caps?.promptCapabilities,
    cfg: null,
    modes: [],
  }
}

/** Ids only, for call sites that just need to test membership. */
export function modeIds(state: ACPState): string[] {
  return state.modes.map((mode) => mode.id)
}

/**
 * Extract advertised modes from the raw `modes` field returned by
 * loadSession/resumeSession. `id` and `name` are required by the spec, so a mode
 * missing either is malformed and dropped rather than shown with a fabricated
 * label; `description` is optional and passed through as-is.
 */
function extractModes(modes: unknown): SessionMode[] {
  if (!modes || typeof modes !== "object") return []
  const obj = modes as Record<string, unknown>
  const available = obj.availableModes
  if (!Array.isArray(available)) return []
  return available.flatMap((entry) => {
    const mode = rec(entry)
    const id = str(mode?.id)
    const name = str(mode?.name)
    if (!id || !name) return []
    const description = str(mode?.description)
    return [{ id, name, ...(description ? { description } : {}) } satisfies SessionMode]
  })
}

function extractCurrentModeId(modes: unknown): string | undefined {
  const obj = rec(modes)
  return obj ? str(obj.currentModeId) : undefined
}

export function merge(state: ACPState, meta: Meta): ACPState {
  const next: ACPState = {
    caps: state.caps,
    prompt: state.prompt,
    cfg: meta.configOptions !== undefined ? meta.configOptions : state.cfg,
    modes: meta.modes !== undefined ? (meta.modes !== null ? extractModes(meta.modes) : []) : state.modes,
  }
  const currentModeId =
    meta.modes !== undefined
      ? meta.modes !== null
        ? extractCurrentModeId(meta.modes)
        : undefined
      : state.currentModeId
  return currentModeId ? { ...next, currentModeId } : next
}

const withLevel = (mode: { id: string; name: string; description?: string }): AgentPermissionMode => {
  return {
    id: mode.id,
    name: mode.name,
    ...(mode.description ? { description: mode.description } : {}),
  }
}

/**
 * The modes a live session actually reported, per harness, learned at runtime.
 *
 * The agent's live answer is the only authority; no connection-specific mode
 * table is consulted for an operator ACP.
 *
 * The observation is process-local because its lifetime matches the process
 * that reported it.
 */
const liveModesSeen = new Map<string, readonly AgentPermissionMode[]>()

/**
 * Record what a live session reported, so later drafts stop guessing.
 *
 * Empty lists are ignored: an agent that has a mode channel but has not
 * populated it yet reports `[]`, and treating that as "this agent has no modes"
 * would erase a good seed on a transient state.
 */
export function rememberLiveModes(harness: string, state: AgentPermissionModeState) {
  if (state.modes.length === 0) return
  liveModesSeen.set(harness, state.modes)
}

/** Test seam — the map is process-global, so suites must be able to reset it. */
export function forgetLiveModes() {
  liveModesSeen.clear()
}

/**
 * Returns the modes observed from live sessions for use in session drafts.
 *
 * `currentModeId` is deliberately never carried over from the remembered state.
 * It named the mode of some OTHER session, and a draft claiming it as current
 * would be the same species of lie this file exists to remove.
 */
export function draftPermissionModes(harness: string): AgentPermissionModeState {
  const modes = liveModesSeen.get(harness)
  if (!modes) return { modes: [], appliesFrom: "next-turn" }
  return { modes: [...modes], appliesFrom: "next-turn" }
}

/**
 * The session's permission modes, from whichever channel this agent speaks.
 *
 * `configOptions` is the richer channel; `session/set_mode` is an independent
 * protocol channel implemented by agents that do not publish config options.
 *
 * Matching is on `category === "mode"` rather than `id === "mode"` (`pick` does
 * both): category is the protocol's semantic field.
 *
 * `unsupported` is reserved for an agent with NEITHER channel. An agent that has
 * a channel and reported nothing yet returns empty modes, which is a different
 * situation and must not be collapsed into the same message.
 */
export function permissionModes(state: ACPState): AgentPermissionModeState {
  const cfg = pick(state.cfg, "mode")
  if (cfg && cfg.type === "select") {
    const options = flat(cfg.options ?? [])
    return {
      modes: options.map((opt) => withLevel({ id: String(opt.value), name: opt.name, ...(opt.description ? { description: opt.description } : {}) })),
      ...(currentValue(cfg) ? { currentModeId: currentValue(cfg) } : {}),
      appliesFrom: "next-turn",
    }
  }
  if (state.modes.length > 0) {
    return {
      modes: state.modes.map((mode) => withLevel({ id: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })),
      ...(state.currentModeId ? { currentModeId: state.currentModeId } : {}),
      appliesFrom: "next-turn",
    }
  }
  return {
    modes: [],
    ...(state.cfg === null && state.caps ? { unsupported: "This agent does not expose permission modes" } : {}),
    appliesFrom: "next-turn",
  }
}

/**
 * Select a mode, then report what the agent actually kept.
 *
 * The returned state comes from re-reading, never from echoing `modeId`. Both
 * write paths make that necessary for the same reason from opposite directions:
 * `set_config_option` answers with the COMPLETE refreshed option list (which is
 * why the result replaces `cfg` rather than being merged into it), and
 * `set_mode` answers with nothing at all, so the only truthful current value is
 * whatever the next `session/update` reports.
 */
export async function setPermissionMode(
  conn: ACPConn,
  state: ACPState,
  sessionId: string,
  modeId: string,
): Promise<{ state: ACPState; result: AgentPermissionModeState }> {
  const cfg = pick(state.cfg, "mode")
  if (cfg && cfg.type === "select") {
    const known = flat(cfg.options ?? []).some((opt) => String(opt.value) === modeId)
    if (!known) throw new Error(`ACP agent does not offer permission mode "${modeId}"`)
    const next = merge(
      state,
      (await conn.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: cfg.id,
        value: modeId,
      })) as Meta,
    )
    return { state: next, result: permissionModes(next) }
  }
  if (state.modes.some((mode) => mode.id === modeId)) {
    await conn.request(methods.agent.session.setMode, { sessionId, modeId })
    // `set_mode` returns no state. Record the requested mode so the UI remains
    // populated until the agent's next `session/update` synchronizes it.
    const next: ACPState = { ...state, currentModeId: modeId }
    return { state: next, result: permissionModes(next) }
  }
  throw new Error(`ACP agent does not offer permission mode "${modeId}"`)
}

/** Derive available agents from ACP session state (config options or modeIds). */
export function extractAgents(state: ACPState): Array<{ name: string; description?: string; mode: string }> {
  // Prefer config-based mode options (newer protocol path)
  const modeCfg = pick(state.cfg, "mode")
  if (modeCfg && modeCfg.type === "select") {
    const options = flat(modeCfg.options ?? [])
    if (options.length > 0) {
      return options.map((opt) => ({
        name: String(opt.value),
        description: opt.name ?? String(opt.value),
        mode: "primary",
      }))
    }
  }

  return []
}

export function model(input: PromptInput["model"], variant?: string) {
  return variant ? `${input.providerID}/${input.modelID}/${variant}` : `${input.providerID}/${input.modelID}`
}

function ids(input: PromptInput["model"], variant?: string) {
  const out = [
    model(input, variant),
    `${input.providerID}/${input.modelID}`,
    ...(variant ? [`${input.modelID}/${variant}`] : []),
    input.modelID,
  ]
  return [...new Set(out)]
}

export async function resume(
  conn: ACPConn,
  state: ACPState,
  sessionId: string,
  cwd: string,
  mcpServers: McpServer[] = [],
) {
  const request = { sessionId, cwd, mcpServers }
  if (state.caps?.sessionCapabilities?.resume) {
    const result = await conn.request(methods.agent.session.resume, request) as Meta
    return { kind: "resume" as const, state: merge(state, result) }
  }
  if (state.caps?.loadSession) {
    const result = await conn.request(methods.agent.session.load, request) as Meta | undefined
    return { kind: "load" as const, state: merge(state, result ?? {}) }
  }
  throw new Error("ACP agent does not advertise session resume or load support")
}

export async function sync(
  conn: ACPConn,
  state: ACPState,
  sessionId: string,
  input: PromptInput,
  options: { syncMode?: boolean } = {},
) {
  let next = state

  if (options.syncMode !== false) {
    const mode = pick(next.cfg, "mode")
    const mid = match(mode, [input.agent])
    if (mid && currentValue(mode) !== mid) {
      next = merge(
        next,
        await conn.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: mode!.id,
          value: mid,
        }),
      )
    } else if (next.modes.length > 0) {
      // Only call setSessionMode if the agent name matches a known ACP mode.
      // OpenCode agent names (e.g. "General") don't map to ACP modes (e.g. "code", "plan").
      const lower = input.agent.toLowerCase()
      const matched = modeIds(next).find((id) => id === input.agent || id === lower)
      if (matched) {
        await conn.request(methods.agent.session.setMode, { sessionId, modeId: matched })
      }
    }
  }

  const effort = pick(next.cfg, "thought_level")
  const effortId = input.variant ? match(effort, [input.variant, input.variant.toLowerCase()]) : undefined
  if (effortId && currentValue(effort) !== effortId) {
    next = merge(
      next,
      await conn.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: effort!.id,
        value: effortId,
      }),
    )
  }

  const cfg = pick(next.cfg, "model")
  const aid = match(cfg, ids(input.model, input.variant))
  if (aid) {
    // Skip if already set to the desired value — redundant setSessionConfigOption
    // calls inject visible "/model" local commands into the ACP agent's conversation.
    if (currentValue(cfg) === aid) return next
    next = merge(
      next,
      await conn.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: cfg!.id,
        value: aid,
      }),
    )
    return next
  }
  return next
}

export function blocks(
  parts: unknown[],
  system: string | undefined,
  caps: PromptCapabilities | null | undefined,
): ContentBlock[] {
  const out: ContentBlock[] = system ? [{ type: "text", text: system, annotations: { audience: ["assistant"] } }] : []
  parts.forEach((part, index) => out.push(contentBlock(part, index, caps)))

  return out
}

function contentBlock(part: unknown, index: number, caps: PromptCapabilities | null | undefined): ContentBlock {
  const row = rec(part)
  switch (str(row?.type)) {
    case "text":
      return { type: "text", text: str(row?.text) ?? "" }
    case "resource_link":
      return resourceLink(row)
    case "image":
      return imageBlock(row, caps)
    case "audio":
      return audioBlock(row, caps)
    case "resource":
      return resourceBlock(row, index, caps)
    default:
      return { type: "text", text: JSON.stringify(part) }
  }
}

function resourceLink(row: Record<string, unknown> | null | undefined): ContentBlock {
  const uri = str(row?.uri)
  if (!uri) throw new Error("ACP resource_link prompt part requires uri")
  const mimeType = str(row?.mimeType)
  const title = str(row?.title)
  const description = str(row?.description)
  return {
    type: "resource_link",
    uri,
    name: str(row?.name) ?? title ?? "resource",
    ...(mimeType ? { mimeType } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  }
}

function imageBlock(row: Record<string, unknown> | null | undefined, caps: PromptCapabilities | null | undefined): ContentBlock {
  if (!caps?.image) throw new Error("ACP agent does not support image prompt content")
  const mimeType = str(row?.mimeType)
  const data = str(row?.data)
  if (!mimeType || !data) throw new Error("ACP image prompt part requires mimeType and data")
  const uri = str(row?.uri)
  return { type: "image", mimeType, data, ...(uri ? { uri } : {}) }
}

function audioBlock(row: Record<string, unknown> | null | undefined, caps: PromptCapabilities | null | undefined): ContentBlock {
  if (!caps?.audio) throw new Error("ACP agent does not support audio prompt content")
  const mimeType = str(row?.mimeType)
  const data = str(row?.data)
  if (!mimeType || !data) throw new Error("ACP audio prompt part requires mimeType and data")
  return { type: "audio", mimeType, data }
}

function resourceBlock(row: Record<string, unknown> | null | undefined, index: number, caps: PromptCapabilities | null | undefined): ContentBlock {
  const item = rec(row?.resource)
  const text = str(item?.text)
  if (!caps?.embeddedContext) {
    if (text) return { type: "text", text }
    throw new Error("ACP agent does not support embedded resource prompt content")
  }
  const uri = str(item?.uri) ?? `wr://resource/${index}`
  const mimeType = str(item?.mimeType)
  if (text) return { type: "resource", resource: { uri, text, ...(mimeType ? { mimeType } : {}) } }
  const blob = str(item?.blob)
  if (blob) return { type: "resource", resource: { uri, blob, ...(mimeType ? { mimeType } : {}) } }
  throw new Error("ACP embedded resource prompt part is invalid")
}
