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
import { asRecord, isRecord } from "@claxedo/agent-runtime-contract"
import path from "path"
import { pathToFileURL } from "url"
import type { PromptInput } from "../../index"
import {
  deliverPromptAttachments,
  isPromptImageMime,
  promptAttachments,
  type PromptAttachment,
} from "../shared/prompt-attachments"
import { extractTextFromParts } from "../shared/sdk-runtime-values"
import type {
  AgentConfigOptions,
  AgentPermissionMode,
  AgentPermissionModeState,
  ResolvedHarnessModel,
} from "../../adapter-contract"
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
  /**
   * The agent's model state, as `session/new`, `session/load` and
   * `session/resume` report it. Read untyped because the model channel is an
   * agent-side extension rather than a field of the negotiated response type.
   */
  models?: unknown
}

function str(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

/**
 * A session response's Claxedo-visible extension fields.
 *
 * `configOptions` keeps only entries that carry the identity the pickers below
 * read (`id`, `type`, `name`); the option variants' own fields are the agent's
 * and travel through unread.
 */
function sessionMeta(value: unknown): Meta {
  const row = asRecord(value)
  if (!row) return {}
  return {
    ...(row.configOptions === undefined
      ? {}
      : { configOptions: Array.isArray(row.configOptions) ? row.configOptions.filter(isSessionConfigOption) : null }),
    ...(row.modes === undefined ? {} : { modes: row.modes }),
    ...(row.models === undefined ? {} : { models: row.models }),
  }
}

function isSessionConfigOption(value: unknown): value is SessionConfigOption {
  return isRecord(value) && typeof value.id === "string" && typeof value.type === "string" && typeof value.name === "string"
}

export function goalExtension(meta: unknown): ACPGoalExtension | null {
  const root = asRecord(meta)
  const goal = asRecord(root?.goal)
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
  const knownOptional: ReadonlySet<string> = new Set<string>(GOAL_OPTIONAL_FIELDS)
  const optionalFields = Array.isArray(goal.optionalFields)
    ? goal.optionalFields.filter((item): item is GoalOptionalField => typeof item === "string" && knownOptional.has(item))
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

/** Config options as the agent reported them, before the contract's normalization. */
export type AcpConfigOptions = { options: SessionConfigOption[]; resolvedModel?: ResolvedHarnessModel }

/** One process's cached discovery answers, in the ACP protocol's own shape. */
export function acpProcessOptions(proc: {
  cachedConfigOptions: SessionConfigOption[] | null
  cachedResolvedModel: ResolvedHarnessModel | null
}): AcpConfigOptions {
  return {
    options: proc.cachedConfigOptions ?? [],
    ...(proc.cachedResolvedModel ? { resolvedModel: proc.cachedResolvedModel } : {}),
  }
}

/** The same answers as the adapter contract states them: protocol nulls read as absent. */
export function acpConfigOptions(probed: AcpConfigOptions): AgentConfigOptions {
  return {
    options: probed.options.map((option) => ({
      ...option,
      description: option.description ?? undefined,
      category: option.category ?? undefined,
    })),
    ...(probed.resolvedModel ? { resolvedModel: probed.resolvedModel } : {}),
  }
}

/** A select's options, with any group flattened into the options it holds. */
function flat(options: SessionConfigSelectOption[] | SessionConfigSelectGroup[]): SessionConfigSelectOption[] {
  const entries: Array<SessionConfigSelectOption | SessionConfigSelectGroup> = options
  return entries.flatMap((entry) => "group" in entry ? entry.options : [entry])
}

function pick(cfg: SessionConfigOption[] | null, kind: "mode" | "model" | "thought_level") {
  return cfg?.find((item) => item.type === "select" && (item.category === kind || item.id === kind)) ?? null
}

function match(opt: SessionConfigOption | null, ids: string[]) {
  if (!opt || opt.type !== "select") return null
  const set = new Set(ids)
  return flat(opt.options ?? []).find((item) => set.has(item.value))?.value
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
  /**
   * The model the agent named as current, from its model channel.
   *
   * Absent when the agent named none, or named one it gave no label for. An
   * agent that publishes a `model` config option instead is served from that
   * option by {@link resolvedModel}, so this holds only what the model channel
   * itself reported.
   */
  model?: ResolvedHarnessModel
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
  const obj = asRecord(modes)
  if (!obj) return []
  const available = obj.availableModes
  if (!Array.isArray(available)) return []
  return available.flatMap((entry) => {
    const mode = asRecord(entry)
    const id = str(mode?.id)
    const name = str(mode?.name)
    if (!id || !name) return []
    const description = str(mode?.description)
    return [{ id, name, ...(description ? { description } : {}) } satisfies SessionMode]
  })
}

function extractCurrentModeId(modes: unknown): string | undefined {
  const obj = asRecord(modes)
  return obj ? str(obj.currentModeId) : undefined
}

/**
 * The current model from the agent's model state.
 *
 * `currentModelId` names it and the matching entry of `availableModels` labels
 * it. An id the agent listed no entry for yields nothing: the agent named a
 * model it never described, and inventing a label for it would put a Claxedo
 * string where the agent's own word belongs.
 */
function extractResolvedModel(models: unknown): ResolvedHarnessModel | undefined {
  const state = asRecord(models)
  const id = str(state?.currentModelId)
  if (!id) return undefined
  const available = Array.isArray(state?.availableModels) ? state.availableModels : []
  const info = available.map((entry: unknown) => asRecord(entry)).find((entry) => str(entry?.modelId) === id)
  const name = str(info?.name)
  return name ? { id, name } : undefined
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
  const model = meta.models !== undefined
    ? (meta.models !== null ? extractResolvedModel(meta.models) : undefined)
    : state.model
  return {
    ...next,
    ...(currentModeId ? { currentModeId } : {}),
    ...(model ? { model } : {}),
  }
}

/**
 * The model this agent will use, from whichever channel it speaks.
 *
 * The model channel is authoritative when the agent has one; otherwise the
 * `model` config option's current value carries the same answer. An agent with
 * neither resolves to nothing, which is the truthful report that it named no
 * model at all.
 */
export function resolvedModel(state: ACPState): ResolvedHarnessModel | undefined {
  if (state.model) return state.model
  const cfg = pick(state.cfg, "model")
  const id = currentValue(cfg)
  if (!cfg || cfg.type !== "select" || !id) return undefined
  const name = flat(cfg.options ?? []).find((item) => item.value === id)?.name
  return name ? { id, name } : undefined
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
 * Record live session modes for later session drafts.
 *
 * Empty lists are ignored: an agent that has a mode channel but has not
 * populated it yet reports `[]`, and treating that as "this agent has no modes"
 * would erase a good seed on a transient state.
 */
export function rememberLiveModes(harness: string, state: AgentPermissionModeState) {
  if (state.modes.length === 0) return
  liveModesSeen.set(harness, state.modes)
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
      modes: options.map((opt) => withLevel({ id: opt.value, name: opt.name, ...(opt.description ? { description: opt.description } : {}) })),
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
    const known = flat(cfg.options ?? []).some((opt) => opt.value === modeId)
    if (!known) throw new Error(`ACP agent does not offer permission mode "${modeId}"`)
    const next = merge(
      state,
      sessionMeta(await conn.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: cfg.id,
        value: modeId,
      })),
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
  // Config-option modes take precedence over mode ids.
  const modeCfg = pick(state.cfg, "mode")
  if (modeCfg && modeCfg.type === "select") {
    const options = flat(modeCfg.options ?? [])
    if (options.length > 0) {
      return options.map((opt) => ({
        name: opt.value,
        description: opt.name ?? opt.value,
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
    const result = sessionMeta(await conn.request(methods.agent.session.resume, request))
    return { kind: "resume" as const, state: merge(state, result) }
  }
  if (state.caps?.loadSession) {
    const result = sessionMeta(await conn.request(methods.agent.session.load, request))
    return { kind: "load" as const, state: merge(state, result) }
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
      // Connection-specific agent names do not necessarily map to ACP modes.
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

/** One attachment of a prompt, carrying the workspace path when one was written. */
type PromptBlockAttachment = PromptAttachment & { path?: string }

/**
 * The prompt as `session/prompt` blocks: the system block, the user's text, then
 * one block per attachment.
 *
 * A `directory` says the agent shares this filesystem, so every attachment is
 * written there and the text names each path — the delivery every agent can act
 * on with its own tools. Without one the bytes travel alone, because a path the
 * agent cannot open is not a delivery.
 */
export async function blocks(input: {
  parts: readonly unknown[]
  system: string | undefined
  caps: PromptCapabilities | null | undefined
  directory?: string
}): Promise<ContentBlock[]> {
  const delivery: { text: string; attachments: PromptBlockAttachment[] } = input.directory
    ? await deliverPromptAttachments({ parts: input.parts, directory: input.directory })
    : { text: extractTextFromParts([...input.parts]), attachments: promptAttachments(input.parts) }
  const out: ContentBlock[] = input.system
    ? [{ type: "text", text: input.system, annotations: { audience: ["assistant"] } }]
    : []
  if (delivery.text) out.push({ type: "text", text: delivery.text })
  delivery.attachments.forEach((attachment, index) => out.push(attachmentBlock(attachment, index, input.caps)))
  return out
}

/**
 * The block that carries one attachment, in the order of what the agent can take.
 *
 * `PromptRequest.prompt` states the choice: "As a baseline, the Agent MUST
 * support [`ContentBlock::Text`] and [`ContentBlock::ResourceLink`], while
 * other variants are optionally enabled via [`PromptCapabilities`]". So the
 * picture, the sound and the bytes go inline where the agent negotiated them,
 * and a link to the workspace file is what every other agent gets.
 *
 * An agent that negotiated none of the three and shares no filesystem cannot
 * receive the attachment at all. That is an error: the user attached a file and
 * a silent drop would have the turn answer as if they had not.
 */
function attachmentBlock(
  attachment: PromptBlockAttachment,
  index: number,
  caps: PromptCapabilities | null | undefined,
): ContentBlock {
  const file = attachment.path
  if (caps?.image && isPromptImageMime(attachment.mime)) {
    return {
      type: "image",
      mimeType: attachment.mime,
      data: attachment.base64,
      ...(file ? { uri: pathToFileURL(file).href } : {}),
    }
  }
  if (caps?.audio && attachment.mime.startsWith("audio/")) {
    return { type: "audio", mimeType: attachment.mime, data: attachment.base64 }
  }
  if (caps?.embeddedContext) {
    return {
      type: "resource",
      resource: {
        uri: file ? pathToFileURL(file).href : `wr://attachment/${index}`,
        blob: attachment.base64,
        mimeType: attachment.mime,
      },
    }
  }
  if (file) {
    return {
      type: "resource_link",
      uri: pathToFileURL(file).href,
      name: attachment.filename ?? path.basename(file),
      mimeType: attachment.mime,
    }
  }
  throw new Error(
    `ACP agent cannot receive a ${attachment.mime} attachment: it negotiated no inline content and does not share the workspace`,
  )
}
