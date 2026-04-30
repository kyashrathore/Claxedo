import type {
  ClientSideConnection,
  ContentBlock,
  InitializeResponse,
  McpServer,
  PromptCapabilities,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk"
import type { PromptInput } from "./index"

type Caps = InitializeResponse["agentCapabilities"] | null | undefined
type Meta = {
  configOptions?: SessionConfigOption[] | null
  modes?: unknown
  models?: unknown
}

function rec(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
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
  /** Available ACP mode IDs (e.g. ["code", "plan"]). Empty = modes not supported. */
  modeIds: string[]
  models: boolean
  /** Last modelId sent via unstable_setSessionModel, used to skip redundant calls. */
  lastModelId?: string
}

export type ACPConn = Pick<
  ClientSideConnection,
  "loadSession" | "setSessionConfigOption" | "setSessionMode" | "unstable_resumeSession" | "unstable_setSessionModel"
>

export function init(caps: Caps): ACPState {
  return {
    caps,
    prompt: caps?.promptCapabilities,
    cfg: null,
    modeIds: [],
    models: false,
  }
}

/** Extract mode IDs from the raw modes field returned by loadSession/resumeSession. */
function extractModeIds(modes: unknown): string[] {
  if (!modes || typeof modes !== "object") return []
  const obj = modes as Record<string, unknown>
  const available = obj.availableModes
  if (!Array.isArray(available)) return []
  return available
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === "string")
}

export function merge(state: ACPState, meta: Meta): ACPState {
  return {
    caps: state.caps,
    prompt: state.prompt,
    cfg: meta.configOptions !== undefined ? meta.configOptions : state.cfg,
    modeIds: meta.modes !== undefined
      ? (meta.modes !== null ? extractModeIds(meta.modes) : [])
      : state.modeIds,
    models: meta.models !== undefined ? meta.models !== null : state.models,
    lastModelId: state.lastModelId,
  }
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

  // Fall back to legacy modeIds
  if (state.modeIds.length > 0) {
    return state.modeIds.map((id) => ({
      name: id,
      mode: "primary",
    }))
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

export async function resume(conn: ACPConn, state: ACPState, sessionId: string, cwd: string, mcpServers: McpServer[] = []) {
  if (state.caps?.sessionCapabilities?.resume) {
    const result = await conn.unstable_resumeSession({ sessionId, cwd, mcpServers })
    return { kind: "resume" as const, state: merge(state, result) }
  }
  if (state.caps?.loadSession) {
    const result = await conn.loadSession({ sessionId, cwd, mcpServers })
    return { kind: "load" as const, state: merge(state, result) }
  }
  throw new Error("ACP agent does not advertise session resume or load support")
}

export async function sync(conn: ACPConn, state: ACPState, sessionId: string, input: PromptInput) {
  let next = state

  const mode = pick(next.cfg, "mode")
  const mid = match(mode, [input.agent])
  if (mid && currentValue(mode) !== mid) {
    next = merge(next, await conn.setSessionConfigOption({
      sessionId,
      configId: mode!.id,
      value: mid,
    }))
  } else if (next.modeIds.length > 0) {
    // Only call setSessionMode if the agent name matches a known ACP mode.
    // OpenCode agent names (e.g. "General") don't map to ACP modes (e.g. "code", "plan").
    const lower = input.agent.toLowerCase()
    const matched = next.modeIds.find((id) => id === input.agent || id === lower)
    if (matched) {
      await conn.setSessionMode({ sessionId, modeId: matched })
    }
  }

  const cfg = pick(next.cfg, "model")
  const aid = match(cfg, ids(input.model, input.variant))
  if (aid) {
    // Skip if already set to the desired value — redundant setSessionConfigOption
    // calls inject visible "/model" local commands into the ACP agent's conversation.
    if (currentValue(cfg) === aid) return next
    next = merge(next, await conn.setSessionConfigOption({
      sessionId,
      configId: cfg!.id,
      value: aid,
    }))
    return next
  }
  if (next.models) {
    // Send bare modelID (+ optional variant suffix). The providerID is a synthetic
    // runner type (e.g. "claude-acp") that the ACP binary doesn't understand.
    const modelId = input.variant
      ? `${input.model.modelID}/${input.variant}`
      : input.model.modelID
    // Skip if the last-synced model matches — avoids redundant "/model" commands
    // in the ACP agent's conversation context.
    if (next.lastModelId === modelId) return next
    await conn.unstable_setSessionModel({ sessionId, modelId })
    next = { ...next, lastModelId: modelId }
  }
  return next
}

export function blocks(parts: unknown[], system: string | undefined, caps: PromptCapabilities | null | undefined): ContentBlock[] {
  const out: ContentBlock[] = system
    ? [{ type: "text", text: system, annotations: { audience: ["assistant"] } }]
    : []

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
