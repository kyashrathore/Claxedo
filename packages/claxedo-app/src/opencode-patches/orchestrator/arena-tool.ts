import { Tool } from "@/tool/tool"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import type { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import z from "zod"

const log = Log.create({ service: "arena.tool" })

const arenaRoles = [
  { name: "reviewer", role: "reviewer", duty: "Review the page content and provide concrete findings." },
  { name: "critic", role: "challenger", duty: "Challenge assumptions, identify risks, and spot gaps." },
  { name: "editor", role: "synthesizer", duty: "Synthesize consensus and propose actionable next steps." },
  { name: "researcher", role: "researcher", duty: "Bring supporting evidence and alternative approaches." },
  { name: "planner", role: "planner", duty: "Turn conclusions into a prioritized execution plan." },
] as const

const parameters = z.object({
  prompt: z.string().min(1).describe("User objective for the multi-agent run."),
  page_id: z.string().optional().describe("Target page id. Required when not inferable."),
  targets: z.array(z.string()).optional().describe("Optional @agent targets for this run."),
  models: z
    .array(z.string())
    .max(5)
    .optional()
    .describe("Optional list of provider/model ids (for example: openai/gpt-5, anthropic/claude-sonnet-4)."),
  agents: z
    .array(
      z.object({
        name: z.string(),
        role: z.string(),
        duty: z.string(),
        model: z.string(),
        style: z.string().optional(),
        temperature: z.number().optional(),
      }),
    )
    .max(5)
    .optional()
    .describe("Optional explicit arena member config."),
  timeout_ms: z
    .number()
    .int()
    .min(20_000)
    .max(10 * 60 * 1000)
    .optional()
    .describe("Optional wait timeout for wave completion."),
})

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const cleanModelToken = (value: string) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "")

const extractModelsFromPrompt = (value: string) =>
  [...value.matchAll(/\b([a-z0-9._-]+\/[a-z0-9._:-]+)\b/gi)]
    .map((item) => clean(item[1]).toLowerCase())
    .filter(Boolean)

const splitModel = (value: string) => {
  const source = clean(value)
  const idx = source.indexOf("/")
  if (idx < 1 || idx >= source.length - 1) return undefined
  return {
    providerID: clean(source.slice(0, idx)),
    modelID: clean(source.slice(idx + 1)),
  }
}

const validateModel = async (value: string) => {
  const parsed = splitModel(value)
  if (!parsed) return ""
  const providerID = clean(parsed.providerID)
  const modelID = clean(parsed.modelID)
  if (!providerID || !modelID) return ""
  const model = await Provider.getModel(providerID, modelID).catch(() => undefined)
  if (!model) return ""
  return `${providerID}/${model.id}`
}

const currentModel = (ctx: Tool.Context) => {
  const source = (ctx.extra || {}) as Record<string, unknown>
  const raw = source.model as Record<string, unknown> | undefined
  const providerID = clean(raw?.providerID)
  const modelID = clean(raw?.id || raw?.modelID || (raw?.api as Record<string, unknown> | undefined)?.id)
  if (!providerID || !modelID) return ""
  return `${providerID}/${modelID}`
}

const deriveAgents = (models: string[]) =>
  models.slice(0, 5).map((model, index) => {
    const shape = arenaRoles[index] || arenaRoles[arenaRoles.length - 1]
    return {
      name: shape.name,
      role: shape.role,
      duty: shape.duty,
      model,
    }
  })

type ArenaState = {
  arena: null | { id: string; status: string; stop_reason?: string }
  agents?: Array<{ model?: string }>
  waves: Array<{ id: string; status: string; round: number; termination?: string }>
  messages: Array<{ id: string; wave_id: string; kind: string; source: string; text: string }>
}

const summarize = (state: ArenaState, wave_id: string) => {
  const wave = state.waves.find((item) => item.id === wave_id)
  const rows = state.messages
    .filter((item) => item.wave_id === wave_id && item.kind !== "user" && item.source !== "user")
    .filter((item) => clean(item.text).length > 0)
  const lead = rows.slice().reverse().find((item) => item.source === "editor" || item.source === "synthesizer") || rows.at(-1)
  const rest = rows
    .filter((item) => item.id !== lead?.id)
    .slice(-4)
    .map((item) => `@${item.source}: ${clean(item.text)}`)
  const head = lead ? `@${lead.source}: ${clean(lead.text)}` : "No synthesis message was produced."
  const status = wave ? `${wave.status}${clean(wave.termination) ? ` (${clean(wave.termination)})` : ""}` : "unknown"
  return `Arena run ${wave_id} status: ${status}\n\nPrimary synthesis:\n${head}${rest.length ? `\n\nAdditional viewpoints:\n${rest.join("\n\n")}` : ""}`
}

const findPageID = (value: string, messages: MessageV2.WithParts[]) => {
  const direct = clean(value)
  if (direct) return direct
  const merged = messages
    .filter((item) => item.info.role === "user")
    .flatMap((item) => item.parts)
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? clean(part.text) : ""))
    .join("\n")
  const match = /\b(page_[a-z0-9_-]+)\b/i.exec(merged)
  return clean(match?.[1] || "")
}

export const ArenaOrchestratorTool = Tool.define("arena_orchestrator", async () => ({
  description:
    "Run page-scoped multi-agent analysis in Arena and return a synthesized result. Use this for debates, reviews, and non-overlapping multi-model analysis.",
  parameters,
  async execute(args: z.infer<typeof parameters>, ctx: Tool.Context) {
    const pageID = findPageID(args.page_id || "", ctx.messages)
    if (!pageID) {
      return {
        title: "Arena orchestrator",
        metadata: { ok: false, reason: "missing_page_id" },
        output:
          "Arena orchestrator needs a page id. Re-run with `page_id` (for example: page_...) or include it in your request.",
      }
    }

    const fallback = await validateModel(currentModel(ctx))
    const candidates = [
      ...new Set(
        [...(args.models || []), ...extractModelsFromPrompt(args.prompt)]
          .map((item) => clean(item).toLowerCase())
          .filter((item) => cleanModelToken(item).length > 0),
      ),
    ]
    const checked = await Promise.all(candidates.map((item) => validateModel(item)))
    const models = [...new Set(checked.filter(Boolean))]
    const agentsFromModels = models.length ? deriveAgents(models) : undefined
    const agentsFromInput = args.agents?.length
      ? (
          await Promise.all(
            args.agents.map(async (item) => {
              const model = (await validateModel(item.model)) || fallback
              if (!model) return undefined
              return {
                name: clean(item.name) || "agent",
                role: clean(item.role) || "participant",
                duty: clean(item.duty) || "Contribute toward the user goal.",
                model,
                ...(clean(item.style) ? { style: clean(item.style) } : {}),
                ...(typeof item.temperature === "number" ? { temperature: item.temperature } : {}),
              }
            }),
          )
        ).filter((item): item is NonNullable<typeof item> => !!item)
      : undefined
    let agents =
      agentsFromInput && agentsFromInput.length > 0
        ? agentsFromInput
        : agentsFromModels && agentsFromModels.length > 0
          ? agentsFromModels
          : undefined
    const timeout = args.timeout_ms ?? 180_000

    const { Server } = await import("@/server/server")
    const origin = Server.url().origin
    const directory = Instance.directory
    const q = `directory=${encodeURIComponent(directory)}`
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-directory": directory,
    }

    const request = async <T>(path: string, init?: RequestInit, mode: "json" | "text" = "json") => {
      const res = await fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}${q}`, {
        ...init,
        headers: { ...headers, ...(init?.headers || {}) },
      })
      const text = await res.text()
      const data = mode === "text" ? text : text.trim() ? JSON.parse(text) : null
      if (res.ok) return data as T
      const detail =
        mode === "json" && data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : text || `HTTP ${res.status}`
      throw new Error(detail)
    }

    const markdown = await request<string>(
      `/api/pages/${encodeURIComponent(pageID)}/export/markdown?raw=1`,
      { method: "GET" },
      "text",
    ).catch(() => "")
    const page_context = clean(markdown).slice(0, 6000)

    ctx.metadata({
      title: "Arena",
      metadata: { phase: "preparing", page_id: pageID },
    })

    const state = await request<ArenaState>(`/api/pages/${encodeURIComponent(pageID)}/arena/state`, { method: "GET" }).catch(
      () => ({ arena: null, waves: [], messages: [] }) as ArenaState,
    )
    const existingModels = (state.agents || [])
      .map((item) => clean(item?.model))
      .filter(Boolean)
    const existingChecked = await Promise.all(existingModels.map((item) => validateModel(item)))
    const existingInvalid = existingModels.length > 0 && existingChecked.some((item) => !item)
    if (existingInvalid && !agents?.length) {
      agents = fallback ? deriveAgents([fallback]) : undefined
    }
    if (existingInvalid && !agents?.length) {
      return {
        title: "Arena orchestrator",
        metadata: { ok: false, reason: "invalid_arena_model", page_id: pageID },
        output:
          "Existing Arena members are configured with invalid models. Re-run with explicit valid `models` or `agents`.",
      }
    }

    if (!state.arena || !!agents?.length) {
      await request(`/api/pages/${encodeURIComponent(pageID)}/arena/start`, {
        method: "POST",
        body: JSON.stringify({
          directory,
          parent_session_id: ctx.sessionID,
          ...(agents?.length ? { config: { agents } } : {}),
        }),
      })
    }

    const sent = await request<{ wave_id: string; state: ArenaState }>(`/api/pages/${encodeURIComponent(pageID)}/arena/message`, {
      method: "POST",
      body: JSON.stringify({
        text: args.prompt,
        ...(args.targets?.length ? { targets: args.targets } : {}),
        ...(page_context ? { page_context } : {}),
      }),
    })
    const waveID = clean(sent.wave_id)

    ctx.metadata({
      title: "Arena",
      metadata: { phase: "running", page_id: pageID, wave_id: waveID, open_arena: true },
    })

    const started = Date.now()
    let latest = sent.state
    while (Date.now() - started < timeout) {
      const wave = latest.waves.find((item) => item.id === waveID)
      if (wave && wave.status !== "running") break
      await sleep(1200)
      latest = await request<ArenaState>(`/api/pages/${encodeURIComponent(pageID)}/arena/state`, { method: "GET" })
      const next = latest.waves.find((item) => item.id === waveID)
      ctx.metadata({
        title: "Arena",
        metadata: {
          phase: "running",
          page_id: pageID,
          wave_id: waveID,
          round: next?.round || 0,
          status: next?.status || "running",
          open_arena: true,
        },
      })
      if (next && next.status !== "running") break
    }

    const wave = latest.waves.find((item) => item.id === waveID)
    const done = !!wave && wave.status !== "running"
    const output = done
      ? summarize(latest, waveID)
      : `Arena run ${waveID} is still running. Open Arena for live progress.`

    log.info("arena tool completed", {
      session_id: ctx.sessionID,
      page_id: pageID,
      wave_id: waveID,
      status: wave?.status || "running",
      termination: clean(wave?.termination),
      model_candidates: candidates,
      selected_models: models,
      existing_invalid_models: existingInvalid,
      fallback_model: fallback || null,
    })

    return {
      title: "Arena orchestrator",
      metadata: {
        ok: true,
        page_id: pageID,
        wave_id: waveID,
        status: wave?.status || "running",
        termination: clean(wave?.termination),
        open_arena: true,
      },
      output,
    }
  },
}))
