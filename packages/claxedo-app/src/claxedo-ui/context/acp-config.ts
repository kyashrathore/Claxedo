import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"

export type RunnerType = "claude-acp" | "codex-acp" | "cursor-acp" | "opencode" | "pi"
export type Readiness = "polling" | "ready" | "degraded" | "error"

export const ACP_DISPLAY_NAMES: Record<string, string> = {
  "claude-agent-acp": "Claude",
  "claude-acp": "Claude",
  "codex-acp": "Codex",
  agent: "Cursor",
  "cursor-agent": "Cursor",
  "cursor-acp": "Cursor",
  "opencode": "OpenCode",
  "pi": "Pi",
}

const MODEL_KEY = "claxedo:acp-model-map"
const RUNNER_KEY = "claxedo:runner-map"
const AGENT_KEY = "claxedo:agent-mode-map"
const LEGACY_MODEL_KEY = "claxedo:acp-model"
const LEGACY_RUNNER_KEY = "claxedo:runner"
const LEGACY_AGENT_KEY = "claxedo:agent-mode"

type RunnerState = {
  type?: RunnerType
  binary?: string | null
  model?: string | null
  activeType?: RunnerType
  activeBinary?: string | null
  status?: "configured" | "ready" | "applying" | "error"
  error?: string
  ready?: boolean
  workspaceId?: string
}

type OptionsSource = "live" | "cache" | "static" | "empty"

interface AcpConfigOption {
  id: string
  name: string
  category?: string | null
  type: "select" | "boolean"
  currentValue: unknown
  options?: Array<{ value: string; name: string; description?: string }>
  selectOptions?: Array<{ id: string; name: string }>
}

type OptionsResponse = {
  options: AcpConfigOption[]
  source: OptionsSource
  stale: boolean
}

type WorkspaceBoot = {
  kind?: "local" | "cloud" | null
  status?: string | null
}

type ScopeState = {
  agentType: "opencode" | "acp" | "unknown"
  acpBinary: string
  runner: RunnerType
  selectedModel: string
  selectedAgent: string
  dynamicModels: { id: string; name: string }[] | null
  readiness: Readiness
  optionsSource: OptionsSource
  optionsStale: boolean
  optionsLoading: boolean
  configError?: string
  workspaceId?: string
}

type ScopeInput = {
  directory?: string
  sessionId?: string
}

type DraftSession = {
  id: string
  directory: string
  runner: RunnerType
  model: string
}

export function acpScope(input: { directory?: string; sessionId?: string; tabId?: string }) {
  if (input.sessionId && input.sessionId !== "new") return `session:${input.directory ?? ""}:${input.sessionId}`
  return `draft:${input.directory ?? ""}:${input.tabId ?? "route"}`
}

export function isDraftScope(scope: string) {
  return scope.startsWith("draft:")
}

export function initialRunner(scope: string, saved?: string, legacy?: string | null): RunnerType {
  return pickRunner(saved ?? (isDraftScope(scope) ? null : legacy), null) ?? "opencode"
}

export function initialValue(scope: string, saved?: string, legacy?: string | null) {
  return saved ?? (isDraftScope(scope) ? "" : legacy ?? "")
}

function read(key: string) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const data = JSON.parse(raw)
    return data && typeof data === "object" ? data as Record<string, string> : {}
  } catch {
    return {}
  }
}

function decodePiModel(input: string) {
  const idx = input.indexOf("/")
  if (idx < 1 || idx === input.length - 1) return
  return {
    provider: input.slice(0, idx),
    model: input.slice(idx + 1),
  }
}

function write(key: string, value: Record<string, string>) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function extractModelsFromConfigOptions(
  options: AcpConfigOption[],
): { models: { id: string; name: string }[]; currentModel?: string } | null {
  const opt = options.find((item) => item.category === "model" && item.type === "select")
  if (!opt) return null
  const models = opt.selectOptions?.length
    ? opt.selectOptions
    : (opt.options ?? []).map((item) => ({ id: item.value, name: item.name }))
  if (models.length === 0) return null
  return {
    models,
    currentModel: typeof opt.currentValue === "string" ? opt.currentValue : undefined,
  }
}

export function pickRunner(type?: string | null, binary?: string | null): RunnerType | undefined {
  if (binary) {
    const name = (binary.includes("/") ? binary.split("/").pop()! : binary).replace(/\.exe$/i, "")
    if (name === "agent" || name === "cursor-agent" || name.includes("cursor")) return "cursor-acp"
    if (name.includes("codex")) return "codex-acp"
    if (name.includes("claude")) return "claude-acp"
  }
  if (type === "claude-acp" || type === "codex-acp" || type === "cursor-acp" || type === "opencode" || type === "pi") return type
}

export function desiredRunner(data: RunnerState): RunnerType | undefined {
  return pickRunner(data.type, data.binary)
}

export function activeRunner(data: RunnerState): RunnerType | undefined {
  return pickRunner(data.activeType ?? data.type, data.activeBinary ?? data.binary)
}

export function failedRunner(data: RunnerState) {
  return data.status === "error" || !!data.error
}

function init() {
  const globalSync = useGlobalSync()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const base = sdk.url
  const request = platform.fetch ?? globalThis.fetch
  const [store, setStore] = createStore<Record<string, ScopeState>>({})

  const runners = read(RUNNER_KEY)
  const models = read(MODEL_KEY)
  const agents = read(AGENT_KEY)
  const seq = new Map<string, number>()
  const seen = new Map<string, string>()
  const inflight = new Map<string, Promise<void>>()
  const drafts = new Map<string, DraftSession>()
  const draftSeq = new Map<string, number>()
  const warming = new Map<string, { seq: number; promise: Promise<DraftSession | undefined> }>()
  const optionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const optionTries = new Map<string, number>()

  function saveScope(scope: string, key: "runner" | "model" | "agent", value: string) {
    if (key === "runner") {
      runners[scope] = value
      write(RUNNER_KEY, runners)
      return
    }
    if (key === "model") {
      if (value) models[scope] = value
      else delete models[scope]
      write(MODEL_KEY, models)
      return
    }
    agents[scope] = value
    write(AGENT_KEY, agents)
  }

  function seed(scope: string) {
    if (store[scope]) return
    const type = initialRunner(scope, runners[scope], localStorage.getItem(LEGACY_RUNNER_KEY))
    const selectedModel = initialValue(scope, models[scope], localStorage.getItem(LEGACY_MODEL_KEY))
    const selectedAgent = initialValue(scope, agents[scope], localStorage.getItem(LEGACY_AGENT_KEY))
    setStore(scope, {
      agentType: type === "opencode" ? "opencode" : "acp",
      acpBinary: "",
      runner: type,
      selectedModel,
      selectedAgent,
      dynamicModels: null,
      readiness: "ready",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
    })
  }

  function touch(scope: string) {
    seed(scope)
    return store[scope]!
  }

  function mode(type?: RunnerType) {
    if (type === "opencode") return "opencode"
    if (type) return "acp"
    return "unknown"
  }

  function binaryName(value: string) {
    return (value.includes("/") ? value.split("/").pop()! : value).replace(/\.exe$/i, "")
  }

  function bump(scope: string) {
    const next = (draftSeq.get(scope) ?? 0) + 1
    draftSeq.set(scope, next)
    return next
  }

  async function removeDraft(item?: DraftSession) {
    if (!item) return
    await sdk.client.session.delete({
      directory: item.directory,
      sessionID: item.id,
    }).catch(() => {})
  }

  function takeDraft(scope: string) {
    bump(scope)
    const item = drafts.get(scope)
    drafts.delete(scope)
    return item
  }

  async function dropDraft(scope: string) {
    await removeDraft(takeDraft(scope))
  }

  async function warmDraft(scope: string, input?: ScopeInput) {
    if (!input?.directory) return
    const state = touch(scope)
    if (state.runner === "opencode" || !state.selectedModel) return

    const item = drafts.get(scope)
    if (item) {
      if (item.directory === input.directory && item.runner === state.runner && item.model === state.selectedModel) {
        return item
      }
      void removeDraft(takeDraft(scope))
    }

    const id = draftSeq.get(scope) ?? 0
    const pending = warming.get(scope)
    if (pending?.seq === id) return pending.promise

    const promise = (async () => {
      try {
        const client = sdk.createClient({
          directory: input.directory,
          throwOnError: true,
          headers: {
            "x-claxedo-runner": state.runner,
            "x-claxedo-model": state.selectedModel,
          },
        })
        const res = await client.session.create({ directory: input.directory })
        const sessionID = res.data?.id
        if (!sessionID) throw new Error("Failed to initialize runner")
        const next = {
          id: sessionID,
          directory: input.directory!,
          runner: state.runner,
          model: state.selectedModel,
        } satisfies DraftSession
        if ((draftSeq.get(scope) ?? 0) !== id) {
          await removeDraft(next)
          return
        }
        drafts.set(scope, next)
        return next
      } catch (err) {
        if ((draftSeq.get(scope) ?? 0) !== id) return
        setStore(scope, "configError", err instanceof Error ? err.message : "Failed to initialize runner")
        setStore(scope, "readiness", "error")
        return
      }
    })()

    warming.set(scope, { seq: id, promise })
    return promise.finally(() => {
      const current = warming.get(scope)
      if (current?.seq === id && current.promise === promise) warming.delete(scope)
    })
  }

  async function refresh(dir?: string, runnerType?: string) {
    if (dir) {
      await globalSync.refreshDirectory(dir, runnerType)
      return
    }
    await globalSync.bootstrap(runnerType)
  }

  function stamp(input?: ScopeInput) {
    return `${input?.directory ?? ""}\n${input?.sessionId && input.sessionId !== "new" ? input.sessionId : "new"}`
  }

  function query(input?: ScopeInput) {
    if (!input?.directory) return ""
    const params = new URLSearchParams()
    params.set("directory", input.directory)
    if (input.sessionId && input.sessionId !== "new") params.set("sessionId", input.sessionId)
    return `?${params}`
  }

  async function workspace(input?: ScopeInput) {
    if (!input?.directory) return
    const params = new URLSearchParams()
    params.set("directory", input.directory)
    const res = await request(`${base}/api/workspace/resolve?${params}`)
    if (!res.ok) return
    return await res.json() as WorkspaceBoot
  }

  async function status(input?: ScopeInput) {
    if (!input?.directory) return
    const res = await request(`${base}/api/claxedo/agent-config/runner${query(input)}`)
    if (!res.ok) return
    return await res.json() as RunnerState
  }

  async function apply(scope: string, data: RunnerState, input?: ScopeInput) {
    const want = desiredRunner(data) ?? store[scope]?.runner ?? "opencode"
    setStore(scope, {
      ...store[scope],
      agentType: mode(want),
      acpBinary: data.activeBinary ?? data.binary ?? "",
      runner: want,
      selectedModel: data.model ?? (want === "opencode" ? "" : store[scope]?.selectedModel ?? ""),
      ...(want === "opencode"
        ? {
            dynamicModels: null,
            optionsSource: "empty" as const,
            optionsStale: false,
            optionsLoading: false,
          }
        : {}),
      readiness: failedRunner(data) ? "error" : "ready",
      configError: data.error ?? undefined,
      workspaceId: data.workspaceId ?? store[scope]?.workspaceId,
    })
    saveScope(scope, "runner", want)
    if (data.model) saveScope(scope, "model", data.model)
    if (want !== "opencode" && !failedRunner(data)) void fetchConfigOptions(scope, want, input)
    if (input?.directory) await refresh(input.directory, want)
  }

  async function fetchConfigOptions(
    scope: string,
    type: RunnerType,
    input?: ScopeInput,
  ): Promise<OptionsResponse | undefined> {
    seed(scope)
    const timer = optionTimers.get(scope)
    if (timer) {
      clearTimeout(timer)
      optionTimers.delete(scope)
    }
    const id = (seq.get(scope) ?? 0) + 1
    seq.set(scope, id)
    setStore(scope, "optionsLoading", true)
    try {
      const params = new URLSearchParams()
      if (input?.directory) params.set("directory", input.directory)
      if (input?.sessionId && input.sessionId !== "new") params.set("sessionId", input.sessionId)
      params.set("type", type)
      const res = await request(`${base}/api/claxedo/agent-config/runner/options?${params}`)
      if (!res.ok) {
        if (seq.get(scope) !== id) return
        optionTries.delete(scope)
        setStore(scope, "dynamicModels", [])
        setStore(scope, "selectedModel", "")
        saveScope(scope, "model", "")
        setStore(scope, "optionsSource", "empty")
        setStore(scope, "optionsStale", true)
        setStore(scope, "optionsLoading", false)
        setStore(scope, "configError", "Failed to load model options")
        return
      }
      const body = await res.json() as OptionsResponse | AcpConfigOption[]
      const payload = Array.isArray(body)
        ? {
            options: body,
            source: "live",
            stale: false,
          } satisfies OptionsResponse
        : body
      if (seq.get(scope) !== id || store[scope]?.runner !== type) return
      const tries = optionTries.get(scope) ?? 0
      setStore(scope, "optionsSource", payload.source)
      setStore(scope, "optionsStale", payload.stale)
      setStore(scope, "optionsLoading", payload.stale)
      if (!payload.stale) optionTries.delete(scope)
      const result = extractModelsFromConfigOptions(payload.options)
      if (!result || result.models.length === 0) {
        setStore(scope, "dynamicModels", [])
        if (!payload.stale) {
          setStore(scope, "selectedModel", "")
          saveScope(scope, "model", "")
        }
        setStore(scope, "configError", payload.stale ? "Loading model options..." : "No model options available")
        if (payload.stale && tries < 5) {
          optionTries.set(scope, tries + 1)
          optionTimers.set(scope, setTimeout(() => {
            if (seq.get(scope) !== id || store[scope]?.runner !== type) return
            void fetchConfigOptions(scope, type, input)
          }, 1000))
        } else {
          setStore(scope, "optionsLoading", false)
        }
        return payload
      }
      setStore(scope, "dynamicModels", result.models)
      setStore(scope, "configError", payload.stale ? "Model list may be outdated" : undefined)
      const current = store[scope]?.selectedModel ?? ""
      const next = result.models.some((item) => item.id === current)
        ? current
        : result.currentModel ?? result.models[0]?.id ?? ""
      if (!next) {
        setStore(scope, "selectedModel", "")
        saveScope(scope, "model", "")
        setStore(scope, "configError", payload.stale ? "Loading model options..." : "No model options available")
        setStore(scope, "optionsLoading", payload.stale)
        return payload
      }
      setStore(scope, "selectedModel", next)
      saveScope(scope, "model", next)
      if (input?.sessionId && input.sessionId !== "new") {
        await request(`${base}/api/claxedo/agent-config/runner/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: next, sessionId: input.sessionId, directory: input.directory }),
        }).catch(() => {})
      }
      if (payload.stale && tries < 5) {
        optionTries.set(scope, tries + 1)
        optionTimers.set(scope, setTimeout(() => {
          if (seq.get(scope) !== id || store[scope]?.runner !== type) return
          void fetchConfigOptions(scope, type, input)
        }, 1000))
      } else {
        setStore(scope, "optionsLoading", false)
      }
      return payload
    } catch {
      if (seq.get(scope) !== id) return
      optionTries.delete(scope)
      setStore(scope, "dynamicModels", [])
      setStore(scope, "selectedModel", "")
      saveScope(scope, "model", "")
      setStore(scope, "optionsSource", "empty")
      setStore(scope, "optionsStale", true)
      setStore(scope, "optionsLoading", false)
      setStore(scope, "configError", "Failed to load model options")
    }
  }

  async function hydrate(scope: string, input?: ScopeInput) {
    seed(scope)
    const key = stamp(input)
    if (seen.get(scope) === key) return
    const pending = inflight.get(scope)
    if (pending) return pending
    const run = (async () => {
      if (!input?.directory) return
      if (!input.sessionId || input.sessionId === "new") {
        const ws = await workspace(input).catch(() => undefined)
        if (ws?.kind === "cloud") {
          const data = await status(input).catch(() => undefined)
          if (data) {
            await apply(scope, data, input)
            seen.set(scope, key)
            return
          }
        }
        const type = store[scope]?.runner ?? "opencode"
        setStore(scope, "agentType", mode(type))
        setStore(scope, "readiness", "ready")
        if (type !== "opencode") {
          void fetchConfigOptions(scope, type, input)
        } else {
          setStore(scope, "optionsSource", "empty")
          setStore(scope, "optionsStale", false)
          setStore(scope, "optionsLoading", false)
        }
        await refresh(input.directory, type)
        seen.set(scope, key)
        return
      }
      const data = await status(input).catch(() => undefined)
      if (!data) {
        // Desktop sidecar doesn't have /api/claxedo/* endpoints — status() returns
        // undefined.  Fall back to the locally-persisted runner (or "opencode"),
        // mark the scope as seen so we don't retry on every effect cycle, and
        // ensure the directory is bootstrapped.
        const fallback = store[scope]?.runner ?? "opencode"
        setStore(scope, "agentType", mode(fallback))
        setStore(scope, "readiness", "ready")
        setStore(scope, "optionsSource", "empty")
        setStore(scope, "optionsStale", false)
        setStore(scope, "optionsLoading", false)
        await refresh(input.directory, fallback)
        seen.set(scope, key)
        return
      }
      await apply(scope, data, input)
      seen.set(scope, key)
    })()
    inflight.set(scope, run)
    return run.finally(() => {
      if (inflight.get(scope) === run) inflight.delete(scope)
    })
  }

  const setModel = async (scope: string, model: string, input?: ScopeInput) => {
    seed(scope)
    setStore(scope, "selectedModel", model)
    saveScope(scope, "model", model)
    if (!input?.sessionId || input.sessionId === "new") {
      void dropDraft(scope)
      return
    }
    await request(`${base}/api/claxedo/agent-config/runner/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, sessionId: input.sessionId, directory: input.directory }),
    }).catch(() => {})
  }

  const setRunner = async (scope: string, type: RunnerType, input?: ScopeInput, binary?: string) => {
    seed(scope)
    void dropDraft(scope)
    setStore(scope, "runner", type)
    setStore(scope, "agentType", mode(type))
    setStore(scope, "selectedModel", "")
    setStore(scope, "dynamicModels", null)
    setStore(scope, "configError", undefined)
    setStore(scope, "readiness", "ready")
    setStore(scope, "optionsSource", "empty")
    setStore(scope, "optionsStale", false)
    setStore(scope, "optionsLoading", type !== "opencode")
    optionTries.delete(scope)
    saveScope(scope, "runner", type)
    saveScope(scope, "model", "")

    if (!input?.sessionId || input.sessionId === "new") {
      const ws = await workspace(input).catch(() => undefined)
      if (ws?.kind === "cloud") {
        try {
          const res = await request(`${base}/api/claxedo/agent-config/runner`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type,
              ...(binary ? { binary } : {}),
              ...(input?.directory ? { directory: input.directory } : {}),
            }),
          })
          if (!res.ok) {
            const body = await res.json().catch(() => null) as { error?: string } | null
            throw new Error(body?.error ?? `Failed to switch to ${type}`)
          }
        } catch (err) {
          setStore(scope, "configError", err instanceof Error ? err.message : "Failed to switch runner")
          setStore(scope, "readiness", "error")
          setStore(scope, "optionsLoading", false)
          return
        }
      }
      if (type === "opencode") {
        setStore(scope, "acpBinary", "")
        await refresh(input?.directory, type)
        return
      }
      void fetchConfigOptions(scope, type, input)
      await refresh(input?.directory, type)
      return
    }

    try {
      const res = await request(`${base}/api/claxedo/agent-config/runner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, binary, sessionId: input.sessionId, directory: input.directory }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `Failed to switch to ${type}`)
      }
      if (binary) setStore(scope, "acpBinary", binary)
      await refresh(input.directory, type)
      if (type === "opencode") {
        setStore(scope, "acpBinary", "")
        setStore(scope, "optionsSource", "empty")
        setStore(scope, "optionsStale", false)
        setStore(scope, "optionsLoading", false)
        return
      }
      void fetchConfigOptions(scope, type, input)
    } catch (err) {
      setStore(scope, "configError", err instanceof Error ? err.message : "Failed to switch runner")
      setStore(scope, "readiness", "error")
      setStore(scope, "optionsLoading", false)
    }
  }

  const setAgent = (scope: string, name: string) => {
    seed(scope)
    setStore(scope, "selectedAgent", name)
    saveScope(scope, "agent", name)
  }

  const promote = (from: string, to: string) => {
    seed(from)
    setStore(to, { ...touch(from) })
    saveScope(to, "runner", store[to].runner)
    saveScope(to, "model", store[to].selectedModel)
    if (store[to].selectedAgent) saveScope(to, "agent", store[to].selectedAgent)
  }

  const displayName = (scope: string) => {
    const state = touch(scope)
    const key = binaryName(state.acpBinary || state.runner)
    return ACP_DISPLAY_NAMES[key] ?? key
  }

  const modelsFor = (scope: string) => {
    const state = touch(scope)
    return state.dynamicModels ?? []
  }

  const acpModelForSubmit = (scope: string) => {
    const state = touch(scope)
    if (state.runner === "opencode") return undefined
    if (!state.selectedModel) return undefined
    const found = modelsFor(scope).find((item) => item.id === state.selectedModel)
    if (!found) return undefined
    if (state.runner === "pi") {
      const hit = decodePiModel(state.selectedModel)
      if (!hit) return undefined
      return {
        id: hit.model,
        name: found.name,
        provider: { id: hit.provider },
      }
    }
    return {
      id: state.selectedModel,
      name: found.name,
      provider: { id: state.runner },
    }
  }

  const claimSession = async (scope: string, input?: ScopeInput) => {
    const state = touch(scope)
    if (state.runner === "opencode") return
    const item = await warmDraft(scope, input)
    if (!item) return
    takeDraft(scope)
    return { id: item.id }
  }

  return {
    hydrate,
    claimSession,
    promote,
    setModel,
    setRunner,
    setAgent,
    agentType: (scope: string) => touch(scope).agentType,
    acpBinary: (scope: string) => touch(scope).acpBinary,
    selectedModel: (scope: string) => touch(scope).selectedModel,
    runner: (scope: string) => touch(scope).runner,
    selectedAgent: (scope: string) => touch(scope).selectedAgent,
    models: (scope: string) => modelsFor(scope),
    displayName,
    isAcpMode: (scope: string) => touch(scope).runner !== "opencode",
    readiness: (scope: string) => touch(scope).readiness,
    optionsSource: (scope: string) => touch(scope).optionsSource,
    optionsStale: (scope: string) => touch(scope).optionsStale,
    optionsLoading: (scope: string) => touch(scope).optionsLoading,
    configError: (scope: string) => touch(scope).configError,
    acpModelForSubmit,
  }
}

export const { use: useAcpConfig, provider: AcpConfigProvider } = createSimpleContext({
  name: "AcpConfig",
  init,
})
