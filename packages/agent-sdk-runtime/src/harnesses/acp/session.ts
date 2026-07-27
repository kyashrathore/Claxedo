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
import type { AgentPermissionMode, AgentPermissionModeState, AutoLevel } from "../../adapter-contract"

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

function flat(options: SessionConfigSelectOption[] | SessionConfigSelectGroup[]) {
  const first = options[0] as Record<string, unknown> | undefined
  if (!first) return [] as SessionConfigSelectOption[]
  if ("group" in first) {
    return (options as SessionConfigSelectGroup[]).flatMap((item) => item.options)
  }
  return options as SessionConfigSelectOption[]
}

function pick(cfg: SessionConfigOption[] | null, kind: "mode" | "model") {
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
   * against, so a client that wants to TELL the user what a mode means has only
   * the agent's own `name`/`description` to show. Dropping those (this used to be
   * `modeIds: string[]`) forced callers to invent their own labels for ids they
   * could only guess at.
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
   * `modes`. Kept rather than inferred from the last write, because agents clamp:
   * claude-agent-acp resets this to `default` when a model change shrinks
   * `availableModes`, so a client that trusts its own request drifts silently.
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

/**
 * Ids that identify a rung, checked against a NORMALISED id (lowercased, with
 * `-` and `_` stripped) so `acceptEdits`, `accept_edits` and `accept-edits` are
 * one entry rather than three.
 *
 * These decide the DEFAULT only. They are never used to label anything: the
 * user always sees the agent's own `name`, because `SessionModeId` is an open
 * string by spec and an id we recognise is still an id whose behaviour we are
 * guessing at. An unrecognised id is left with no level, which means it stays
 * fully selectable but is never chosen automatically — the honest outcome for
 * "we do not know what this does".
 */
const LEVEL_IDS: Record<AutoLevel, readonly string[]> = {
  ask: ["default", "ask", "readonly", "askalways", "manual"],
  /**
   * The rung means FULL ACCESS WITH THE DANGER TIER STILL GATED — everything
   * safe runs, and shell, network, out-of-project and subagent spawns still ask.
   *
   * A bare `auto` used to be excluded here on the reasoning that a classifier
   * "can approve commands as well as edits", with `acceptedits` carrying the
   * rung instead. That inverted the definition: `acceptEdits` auto-accepts edits
   * and then prompts on every Bash call, which is neither full access nor
   * automatic, while a classifier approving the safe tiers and escalating risky
   * ones is exactly what this rung describes.
   *
   * `acceptedits` is deliberately NOT here any more. Agents advertising both —
   * claude-agent-acp reports `auto` and `acceptEdits` — would otherwise expose
   * two auto rungs, and Auto resolves by finding exactly one.
   */
  auto: [
    "auto",
    "autoedit",
    "autoaccept",
    "editauto",
    // codex-acp's middle rung. Confirmed against the live binary, which reports
    // exactly `read-only`, `agent`, `agent-full-access`: `agent` is workspace-write
    // — edits inside the project run, network and anything outside it still ask —
    // which is this rung's definition. Untagged, codex-acp had NO auto rung, so
    // Claxedo's Auto fell through to answering prompts locally on a harness that
    // enforces perfectly well.
    "agent",
    "workspacewrite",
  ],
  full: [
    "fullaccess",
    "bypasspermissions",
    "yolo",
    "dangerfullaccess",
    "bypass",
    // Also from the live codex-acp list. `agentfullaccess` does not match the
    // bare `fullaccess` entry above, so it was landing untagged.
    "agentfullaccess",
  ],
}

const normalizeId = (id: string) => id.toLowerCase().replace(/[-_\s]/g, "")

function levelFor(id: string): AutoLevel | undefined {
  const normalized = normalizeId(id)
  for (const [level, ids] of Object.entries(LEVEL_IDS) as [AutoLevel, readonly string[]][]) {
    if (ids.includes(normalized)) return level
  }
  return undefined
}

const withLevel = (mode: { id: string; name: string; description?: string }): AgentPermissionMode => {
  const level = levelFor(mode.id)
  return {
    id: mode.id,
    name: mode.name,
    ...(mode.description ? { description: mode.description } : {}),
    ...(level ? { level } : {}),
  }
}

/**
 * What an ACP harness offers BEFORE a session exists.
 *
 * An ACP agent advertises its modes on `session/new`, so on a draft there is
 * genuinely nothing to report — but showing nothing meant the composer fell back
 * to Claxedo's own options, which are then discarded the instant the session
 * starts and the agent's real modes take over. Offering a choice that cannot
 * survive the first message is worse than offering none.
 *
 * So a draft offers the RUNGS instead of ids. These are intents, not agent
 * modes, and `setPermissionMode` resolves each to whatever the agent turns out
 * to advertise. They are the one place in this design where Claxedo names a
 * permission option itself, and the names say what the rung does rather than
 * implying an agent feature.
 */
export const ACP_DRAFT_MODES: readonly AgentPermissionMode[] = [
  { id: "ask", name: "Ask for everything", description: "Every tool call waits for you", level: "ask" },
  {
    id: "auto",
    name: "Allow edits, ask before risk",
    description: "Resolved to this agent's matching mode when the session starts",
    level: "auto",
  },
  { id: "full", name: "Allow everything", description: "Resolved to this agent's most permissive mode", level: "full" },
]

/**
 * The session's permission modes, from whichever channel this agent speaks.
 *
 * `configOptions` is preferred over `session/set_mode` because it is the newer
 * and more expressive channel, but the fallback is not vestigial — it is what
 * most agents actually implement today, so both paths are live.
 *
 * Matching is on `category === "mode"` rather than `id === "mode"` (`pick` does
 * both): category is the semantic field, and relying on the id only works
 * because codex-acp and claude-agent-acp happen to have chosen that string.
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
  // A RUNG chosen on a draft resolves here, against what the agent actually
  // advertised once it started. Falls through to the literal id when nothing
  // matches, so an agent whose ids happen to be "ask"/"auto"/"full" still works.
  const resolved = ((): string => {
    if (!["ask", "auto", "full"].includes(modeId)) return modeId
    const advertised = permissionModes(state).modes
    if (advertised.some((mode) => mode.id === modeId)) return modeId
    return advertised.find((mode) => mode.level === modeId)?.id ?? modeId
  })()
  modeId = resolved

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
    // `set_mode` returns no state. Record the request optimistically so the UI is
    // not blank, and let the next `session/update` correct it if the agent
    // clamped to something else.
    const next: ACPState = { ...state, currentModeId: modeId }
    return { state: next, result: permissionModes(next) }
  }
  throw new Error(`ACP agent does not offer permission mode "${modeId}"`)
}

/** Derive available agents from ACP session state (config options or legacy modeIds). */
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
    ...(input.modelID === "default" ? ["default[]"] : []),
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

export async function sync(conn: ACPConn, state: ACPState, sessionId: string, input: PromptInput) {
  let next = state

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

  for (let i = 0; i < parts.length; i++) {
    const row = rec(parts[i])
    const type = str(row?.type)

    if (type === "text") {
      out.push({ type, text: str(row?.text) ?? "" })
      continue
    }

    if (type === "resource_link") {
      const uri = str(row?.uri)
      if (!uri) throw new Error("ACP resource_link prompt part requires uri")
      out.push({
        type,
        uri,
        name: str(row?.name) ?? str(row?.title) ?? "resource",
        ...(str(row?.mimeType) ? { mimeType: str(row?.mimeType)! } : {}),
        ...(str(row?.title) ? { title: str(row?.title)! } : {}),
        ...(str(row?.description) ? { description: str(row?.description)! } : {}),
      })
      continue
    }

    if (type === "image") {
      if (!caps?.image) throw new Error("ACP agent does not support image prompt content")
      const mimeType = str(row?.mimeType)
      const data = str(row?.data)
      if (!mimeType || !data) throw new Error("ACP image prompt part requires mimeType and data")
      out.push({
        type,
        mimeType,
        data,
        ...(str(row?.uri) ? { uri: str(row?.uri)! } : {}),
      })
      continue
    }

    if (type === "audio") {
      if (!caps?.audio) throw new Error("ACP agent does not support audio prompt content")
      const mimeType = str(row?.mimeType)
      const data = str(row?.data)
      if (!mimeType || !data) throw new Error("ACP audio prompt part requires mimeType and data")
      out.push({ type, mimeType, data })
      continue
    }

    if (type === "resource") {
      const item = rec(row?.resource)
      if (caps?.embeddedContext) {
        const uri = str(item?.uri) ?? `wr://resource/${i}`
        if (str(item?.text)) {
          out.push({
            type,
            resource: {
              uri,
              text: str(item?.text)!,
              ...(str(item?.mimeType) ? { mimeType: str(item?.mimeType)! } : {}),
            },
          })
          continue
        }
        if (str(item?.blob)) {
          out.push({
            type,
            resource: {
              uri,
              blob: str(item?.blob)!,
              ...(str(item?.mimeType) ? { mimeType: str(item?.mimeType)! } : {}),
            },
          })
          continue
        }
        throw new Error("ACP embedded resource prompt part is invalid")
      }
      if (str(item?.text)) {
        out.push({ type: "text", text: str(item?.text)! })
        continue
      }
      throw new Error("ACP agent does not support embedded resource prompt content")
    }

    out.push({ type: "text", text: JSON.stringify(parts[i]) })
  }

  return out
}
