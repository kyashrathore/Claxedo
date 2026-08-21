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
 * The versions each table in `ACP_KNOWN_MODES` was recorded from.
 *
 * A hardcoded list of someone else's modes is only true for the build it was
 * copied from, so the version is part of the data rather than a comment.
 * `known-modes.test.ts` compares these against the installed packages and fails
 * on a bump, which turns "the agent changed its modes and we kept showing the
 * old ones" from a silent drift into a failing test with a fix attached:
 * `bun run script/permission-probe.ts` and paste the `liveModesFull` output.
 */
/**
 * Only the agents WE ship can be version-pinned.
 *
 * claude-agent-acp and codex-acp are dependencies of this package, so every
 * install resolves the same build and a mismatch is a real, checkable fact.
 * Cursor is not here on purpose: `cursor-agent` is installed by the user and
 * updates itself, so its version differs per machine and asserting one would
 * fail on other people's laptops for no reason — the pin would be measuring the
 * developer's install, not the code.
 *
 * What covers Cursor instead is `rememberLiveModes`: its table is a seed used
 * only until that user's own agent has answered once, after which their real
 * list is what a draft shows.
 */
export const ACP_KNOWN_MODE_VERSIONS: Partial<Record<string, { package: string; version: string }>> = {
  claude: { package: "@agentclientprotocol/claude-agent-acp", version: "0.63.0" },
  codex: { package: "@agentclientprotocol/codex-acp", version: "1.1.7" },
}

/**
 * What each ACP agent offers, recorded VERBATIM from the live binary.
 *
 * An ACP agent does not advertise its modes until `session/new` returns, so on a
 * draft there is nothing to ask. This table is what a draft shows instead, and
 * every field in it — id, name, description — is the agent's own, captured by
 * `script/permission-probe.ts` from a real binary.
 *
 * It is a SEED, not a claim about the agent the user is running. For claude and
 * codex the two coincide, because this package pins those versions. For cursor
 * they need not: `cursor-agent` is user-installed and self-updating, so a build
 * newer than the one recorded here may have added or renamed a mode. That
 * exposure is bounded in two ways — `rememberLiveModes` replaces this list with
 * the user's own the first time their agent answers, and a live session always
 * supersedes it regardless. What can never happen is the failure this replaced:
 * every entry is an id some build of the agent really advertised, never one
 * Claxedo made up.
 *
 * It replaced three rungs Claxedo named itself ("Allow everything except
 * danger" and friends) which resolved to real ids only once the session began.
 * Those were the one place this design invented a permission option, and the
 * cost was that the picker named a policy the agent had never heard of: a user
 * choosing on a draft was reading Claxedo's vocabulary, then watching the list
 * change under them on the first message. Real ids mean the draft choice IS the
 * session choice, with no resolution step and nothing to re-render.
 *
 * `withLevel` is applied here rather than baked in, so a draft and a live
 * session derive the rung from the same `LEVEL_IDS` table. Hardcoding the level
 * would let the two disagree about the same id — which is the precise bug this
 * whole change is undoing.
 *
 * A harness with no entry here reports nothing on a draft rather than a
 * plausible guess — inventing a table would recreate exactly the fiction this
 * replaced.
 */
export const ACP_KNOWN_MODES: Partial<Record<string, readonly AgentPermissionMode[]>> = {
  claude: [
    { id: "auto", name: "Auto", description: "Use a model classifier to approve/deny permission prompts" },
    { id: "default", name: "Manual", description: "Standard behavior, prompts for dangerous operations" },
    { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edit operations" },
    { id: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution" },
    { id: "dontAsk", name: "Don't Ask", description: "Don't prompt for permissions, deny if not pre-approved" },
    { id: "bypassPermissions", name: "Bypass Permissions", description: "Bypass all permission checks" },
  ].map(withLevel),
  codex: [
    { id: "read-only", name: "Read-only", description: "Requires approval to edit files and run commands." },
    { id: "agent", name: "Agent", description: "Read and edit files, and run commands." },
    {
      id: "agent-full-access",
      name: "Agent (full access)",
      description:
        "Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.",
    },
  ].map(withLevel),
  /**
   * From `cursor-agent acp` — Cursor's CLI acting as its own ACP server.
   *
   * Worth contrasting with `CURSOR_PERMISSION_MODES`, the table the cursor-sdk
   * harness uses: that one is `review`/`auto-review`/`unsandboxed`, derived from
   * two `LocalAgentOptions` booleans, and applies only from the NEXT session
   * because `Agent.create` reads them once. Over ACP the same product exposes
   * three differently-named modes and honours `session/set_mode` mid-session.
   * Same vendor, two transports, genuinely different surfaces — neither table is
   * a stale copy of the other.
   */
  cursor: [
    { id: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
    { id: "plan", name: "Plan", description: "Read-only mode for planning and designing before implementation" },
    { id: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" },
  ].map(withLevel),
}

/**
 * The modes a live session actually reported, per harness, learned at runtime.
 *
 * This is what makes a hardcoded table safe for an agent we do not ship. The
 * table above is only ever a guess about the user's build; the moment their own
 * agent answers, that guess is replaced by fact and never consulted again for
 * that harness. So a Cursor release that renames a mode costs at most one
 * draft's worth of staleness, and only before the user has run it once.
 *
 * Deliberately process-local rather than persisted. Writing it to the store
 * would need a new port member across every store implementation, and the value
 * is small: the seed is already close, and the first session of a run corrects
 * it. A wrong entry surviving a restart would also be worse than no entry —
 * this way the memory can never outlive the process that observed it.
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
 * What to show before a session exists: this user's own list if their agent has
 * ever answered, the recorded seed otherwise, and nothing at all for a harness
 * we have neither observed nor recorded.
 *
 * `currentModeId` is deliberately never carried over from the remembered state.
 * It named the mode of some OTHER session, and a draft claiming it as current
 * would be the same species of lie this file exists to remove.
 */
export function draftPermissionModes(harness: string): AgentPermissionModeState {
  const modes = liveModesSeen.get(harness) ?? ACP_KNOWN_MODES[harness]
  if (!modes) return { modes: [], appliesFrom: "next-turn" }
  return { modes: [...modes], appliesFrom: "next-turn" }
}

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
  // LEGACY. Drafts now offer the agent's own ids (`ACP_KNOWN_MODES`), so a fresh
  // selection needs no resolution. This stays for selections PERSISTED under the
  // old rung ids: a config written before that change still says `auto`, and on
  // codex-acp that has to become `agent` or the first write throws on an id the
  // agent never had. Falls through to the literal id when nothing matches, so
  // claude-acp — which really does advertise `auto` — takes it directly.
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
