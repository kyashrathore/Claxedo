import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { useParams } from "@solidjs/router"
import { z } from "zod"
import { useSync } from "@opencode-ai/claxedo-app"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Decode } from "@opencode-ai/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { extractPromptFromParts } from "@/utils/prompt"
import { getTerminalCommands } from "../../components/settings-terminals"
import { useClaxedoLayout } from "../context/claxedo-layout"
import { CompactPromptDock } from "./compact-prompt-dock"
import { DirectoryScope } from "./directory-scope"
import { schema as jsonRenderSchema } from "@json-render/solid"
import { defineCatalog, createSpecStreamCompiler, type Spec } from "@json-render/core"
import { WorkgraphIssuePicker, workgraphPickerKey } from "./workgraph-issue-picker"
import {
  workgraphApi,
  type WorkgraphDetail,
  type WorkgraphEvent,
  type WorkgraphItem,
  type WorkgraphPreview,
  type WorkgraphRepoBucket,
  type WorkgraphRun,
  type WorkgraphSlice,
} from "../../utils/workgraph-api"

type Mode = "all" | "ready" | "active" | "attention" | "blocked" | "done"
type TreeNode = { item: WorkgraphItem; children: TreeNode[] }
type FlatNode = { item: WorkgraphItem; treeDepth: number; hasChildren: boolean }
const SLICE_KEY = "claxedo:workgraph:slice"
const REPO_KEY = "claxedo:workgraph:repo"
const pickerCatalog = defineCatalog(jsonRenderSchema, {
  components: {
    Stack:   { props: z.object({ gap: z.string().optional() }) },
    Summary: { props: z.object({ provider: z.string(), mode: z.string(), count: z.number(), selected: z.number() }) },
    Next:    { props: z.object({ action: z.enum(["stop_after_ingest", "plan_graph"]) }) },
    Toolbar: { props: z.object({ total: z.number(), selected: z.number(), loading: z.boolean() }) },
    Issue: { props: z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      description: z.string().optional(),
      selected: z.boolean().optional(),
      external_key: z.string().optional(),
      parent_external_key: z.string().optional().nullable(),
      aggregate_only: z.boolean().optional(),
      provider_url: z.string().optional(),
      provider_meta: z.record(z.string(), z.unknown()).optional(),
    }) },
    Auth:  { props: z.object({ provider: z.string(), message: z.string(), hint: z.string() }) },
    Empty: { props: z.object({ title: z.string(), message: z.string() }) },
  },
  actions: {
    toggle:     { params: z.object({ id: z.string() }) },
    select_all: { params: z.object({}) },
    clear:      { params: z.object({}) },
    import:     { params: z.object({}) },
  },
} as any)

const INTAKE_SYSTEM = [
  "You are a WorkGraph intake assistant. Help users add GitHub or Linear issues to their WorkGraph.",
  "Use the gh CLI or any available tools to fetch issues when the user provides a URL or query.",
  "After fetching, present the issue picker using the json-render components below.",
  "For GitHub issues, set external_key = '{owner}/{repo}#{number}' and id = external_key.",
  "Mark all fetched issues as selected: true by default.",
  "CRITICAL: Emit one Issue element per issue with LITERAL string props. Do NOT use repeat, state arrays, $item, $state, or any dynamic expressions. Each issue is a separate named element (e.g. issue_0, issue_1, ...) under the root Stack.",
  "For requests unrelated to WorkGraph, politely decline.",
  "",
  pickerCatalog.prompt({ mode: "inline" }),
].join("\n")

export type TabWorkgraphProps = {
  onBackToIndex?: () => void
}

function fmt(text?: string | null) {
  if (!text) return "Now"
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return date.toLocaleString()
}

function parse(event: WorkgraphEvent) {
  try {
    return JSON.parse(event.payload_json)
  } catch {
    return event.payload_json
  }
}

function nice(text: string) {
  return text
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function line(event: WorkgraphEvent) {
  const data = parse(event)
  const text =
    typeof data === "object" && data
      ? Object.entries(data)
          .filter(([key, value]) => key !== "node_id" && key !== "run_id" && key !== "agent_id" && value !== undefined && value !== null && value !== "")
          .map(([key, value]) => `${nice(key)}: ${typeof value === "string" ? value : String(value)}`)
          .join(" · ")
      : undefined
  if (typeof data === "string") return { title: nice(event.type), body: data }
  if (event.type === "run_created") {
    return { title: "Planning draft created", body: data.goal || "The slice now has a planning run." }
  }
  if (event.type === "planning_started") {
    return { title: "Planner started", body: "WorkGraph is breaking the slice into executable tasks." }
  }
  if (event.type === "node_created") {
    return { title: `Added task: ${data.title || data.node_id || "Untitled task"}`, body: data.kind ? `Kind: ${data.kind}` : undefined }
  }
  if (event.type === "edge_added") {
    return { title: "Linked a dependency", body: "A task dependency was added to the planning graph." }
  }
  if (event.type === "run_planned") {
    return { title: "Graph ready", body: data.summary || "The slice was planned successfully." }
  }
  if (event.type === "planning_failed") {
    return { title: "Planning failed", body: data.error || "The planner exited before the graph was ready." }
  }
  return { title: nice(event.type), body: text }
}

function key(item: WorkgraphPreview) {
  return item.external_key || JSON.stringify(item.provider_meta)
}

function tone(item: WorkgraphItem, attention: boolean, loading: boolean) {
  if (attention) return "Needs attention"
  if (loading || item.status === "in_progress" || item.active_run_id) return "Working"
  if (item.status === "done") return "Done"
  if (item.blocked) return "Blocked"
  if (item.ready) return "Ready"
  return "Queued"
}

function dot(item: WorkgraphItem, attention: boolean, loading: boolean) {
  if (attention) return "var(--icon-critical-base)"
  if (loading || item.status === "in_progress" || item.active_run_id) return "var(--icon-warning-base)"
  if (item.status === "done") return "var(--icon-success-base)"
  if (item.blocked) return "var(--text-weaker)"
  if (item.ready) return "var(--icon-info-base)"
  return "var(--border-base)"
}

function FilterButton(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="px-2 py-1 text-12 transition-colors"
      classList={{
        "text-text-strong": props.active,
        "text-text-weaker hover:text-text-base": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

function StatusBadge(props: { label: string; color: string }) {
  return (
    <span
      class="inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10px] font-medium"
      style={{ color: props.color, "border-color": props.color }}
    >
      {props.label}
    </span>
  )
}

function RichBlock(props: { title: string; text: string; tone?: "plain" | "accent"; meta?: string; noLimit?: boolean }) {
  return (
    <div
      class="rounded-lg border px-3 py-3"
      classList={{
        "border-border-weak-base bg-background-base/60": (props.tone ?? "plain") === "plain",
        "border-border-base bg-surface-base/60": props.tone === "accent",
      }}
    >
      <div class="mb-2 flex items-center justify-between gap-3">
        <div class="text-[10px] uppercase tracking-[0.12em] text-text-weaker">{props.title}</div>
        <Show when={props.meta}>
          <div class="text-[10px] text-text-weaker">{props.meta}</div>
        </Show>
      </div>
      <div
        classList={{ "max-h-56 overflow-y-auto": !props.noLimit }}
        class="pr-1 text-12 leading-6 text-text-base [&_.prose]:max-w-none [&_.prose]:text-inherit [&_.prose_a]:text-text-strong [&_.prose_code]:rounded [&_.prose_code]:bg-surface-base [&_.prose_code]:px-1 [&_.prose_code]:py-0.5 [&_.prose_pre]:overflow-x-auto [&_.prose_pre]:rounded-md [&_.prose_pre]:border [&_.prose_pre]:border-border-weak-base [&_.prose_pre]:bg-background-base [&_.prose_pre]:p-3"
      >
        <Markdown text={props.text} />
      </div>
    </div>
  )
}

function IntakeDock(props: {
  id: string
  onSubmit: () => void
  interactiveSlot?: import("solid-js").JSX.Element
  hideMessages?: boolean
}) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()
  const prompt = usePrompt()
  const [responding, setResponding] = createSignal(false)

  const info = createMemo(() => sync.session.get(props.id))
  const messages = createMemo(() => sync.data.message[props.id] ?? [])
  const users = createMemo(
    () => messages().filter((msg): msg is UserMessage => msg.role === "user"),
  )
  const question = createMemo(() => sync.data.question[props.id]?.[0])
  const permission = createMemo(() => sync.data.permission[props.id]?.[0])
  const blocked = createMemo(() => !!question() || !!permission())
  const idle = { type: "idle" as const }
  const status = createMemo(() => sync.data.session_status[props.id] ?? idle)
  const live = createMemo(() => status().type !== "idle" || blocked())

  const decide = (response: "once" | "always" | "reject") => {
    const req = permission()
    if (!req || responding()) return
    setResponding(true)
    sdk.client.permission.respond({
      sessionID: props.id,
      permissionID: req.id,
      response,
    }).finally(() => setResponding(false))
  }

  return (
    <CompactPromptDock
      title={info()?.title}
      onToggle={() => {}}
      showToggle={false}
      t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
      questionRequest={question}
      permissionRequest={permission}
      blocked={blocked()}
      todos={[]}
      live={live()}
      promptReady={prompt.ready()}
      handoffPrompt={undefined}
      responding={responding()}
      onDecide={decide}
      inputRef={() => {}}
      newSessionWorktree="main"
      onNewSessionWorktreeReset={() => {}}
      onSubmit={props.onSubmit}
      setPromptDockRef={() => {}}
      sessionID={props.id}
      navigateOnCreate={false}
      system={INTAKE_SYSTEM}
      agent="workgraph"
      interactiveSlot={props.interactiveSlot}
      messages={
        props.hideMessages ? undefined : (
          <div class="overflow-y-auto">
            <For each={messages()}>
              {(message) => (
                <SessionTurn
                  sessionID={props.id}
                  messageID={message.id}
                  classes={{
                    root: "min-w-0 w-full relative",
                    content: "flex flex-col justify-between !overflow-visible",
                    container: "w-full px-4",
                  }}
                />
              )}
            </For>
          </div>
        )
      }
    />
  )
}

export function TabWorkgraph(_props: TabWorkgraphProps) {
  const claxedo = useClaxedoLayout()
  const params = useParams()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()

  const [items, setItems] = createSignal<WorkgraphItem[]>([])
  const [slices, setSlices] = createSignal<WorkgraphSlice[]>([])
  const [repos, setRepos] = createSignal<WorkgraphRepoBucket[]>([])
  const [detail, setDetail] = createSignal<WorkgraphDetail>()
  const [mode, setMode] = createSignal<Mode>("all")
  const [repoRef, setRepoRef] = createSignal("__all__")
  const [sliceId, setSliceId] = createSignal("")
  const [runId, setRunId] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string>()
  const [importErr, setImportErr] = createSignal<string>()
  const [intakeId, setIntakeId] = createSignal<string>()
  const [pickerChecked, setPickerChecked] = createSignal<Set<string>>(new Set())
  const [pickerDismissed, setPickerDismissed] = createSignal(false)
  const [graph, setGraph] = createSignal<Record<string, WorkgraphDetail>>({})
  const [collapsedItems, setCollapsedItems] = createSignal<Set<string>>(new Set())
  const [showTrace, setShowTrace] = createSignal(false)
  const [sliceTrace, setSliceTrace] = createSignal<WorkgraphEvent[]>([])
  const [depsTab, setDepsTab] = createSignal<"waits" | "unlocks">("waits")
  const [detailTab, setDetailTab] = createSignal<"overview" | "artifacts" | "history">("overview")
  const [repoDir, setRepoDir] = createSignal<Record<string, string>>({})
  const [repoSeed, setRepoSeed] = createSignal(false)

  const query = createMemo(() => ({
    status: mode() === "attention" ? undefined : mode(),
    repo_ref: repoRef() === "__all__" ? undefined : repoRef(),
    slice_id: sliceId() || undefined,
    run_id: runId() || undefined,
    attention: mode() === "attention",
    search: search().trim() || undefined,
  }))

  const runs = createMemo(() => {
    const map = new Map<string, { run_id: string; label: string }>()
    for (const item of items()) {
      if (item.active_run_id && !map.has(item.active_run_id)) {
        map.set(item.active_run_id, { run_id: item.active_run_id, label: `Active ${item.active_run_id.slice(-6)}` })
      }
      if (item.latest_run_id && !map.has(item.latest_run_id)) {
        map.set(item.latest_run_id, { run_id: item.latest_run_id, label: `Run ${item.latest_run_id.slice(-6)}` })
      }
    }
    return Array.from(map.values())
  })

  const current = createMemo(() => items().find((item) => item.item_id === selected()))
  const slice = createMemo(() => slices().find((item) => item.slice_id === sliceId()))
  const showSlice = createMemo(() => !!slice() && !selected())
  const panel = createMemo(() => (!showSlice() && current() && detail() ? detail() : undefined))
  const sliceItems = createMemo(() => (sliceId() ? items() : []))
  const filtered = createMemo(() => {
    if (search().trim()) return true
    if (sliceId()) return true
    if (runId()) return true
    return mode() !== "all"
  })
  const repoMap = createMemo(() => new Map(repos().map((item) => [item.repo_ref ?? "__unbound__", item])))
  const dir = createMemo(() => {
    const gid = claxedo.split.focusedId()
    const tab = gid ? claxedo.groupTabs(gid).active() : claxedo.topTabs.active()
    if (tab?.directory && tab.directory !== "__pages__") return tab.directory
    const worktree = gid ? claxedo.groupWorktree(gid).default() : claxedo.worktree.default()
    if (worktree && worktree !== "__process__") return worktree
    if (!params.dir) return
    try {
      return base64Decode(params.dir)
    } catch {
      return
    }
  })
  const bucket = (repo?: string | null) => repoMap().get(repo ?? "__unbound__")
  const currentRepo = createMemo(() => bucket(repoRef() === "__all__" ? null : repoRef()))
  const bind = (repo?: string | null) => {
    const key = repo ?? (repoRef() === "__all__" ? null : repoRef())
    const item = bucket(key)
    if (!item?.bindings.length) return
    const picked = repoDir()[item.repo_ref ?? "__unbound__"]
    if (picked && item.bindings.some((row) => row.project_root === picked)) return picked
    const root = dir()
    const hit = root ? item.bindings.find((row) => root === row.project_root || root.startsWith(`${row.project_root}/`)) : undefined
    if (hit) return hit.project_root
    return item.bindings[0]?.project_root
  }
  const dockDir = createMemo(() => bind() ?? dir() ?? globalSync.data.project[0]?.worktree)
  const intakeStore = createMemo(() => {
    const root = dockDir()
    if (!root) return
    return globalSync.child(root, { bootstrap: false })[0]
  })
  const intakeMessages = createMemo(() => {
    const store = intakeStore()
    const id = intakeId()
    if (!store || !id) return [] as Message[]
    return store.message[id] ?? []
  })
  const latestAssistantText = createMemo(() => {
    const store = intakeStore()
    const msgs = intakeMessages()
    const msg = msgs.findLast(
      (m) => m.role === "assistant" && typeof (m as any).time?.completed === "number",
    )
    if (!msg || !store) return ""
    const parts = store.part[msg.id] ?? []
    return parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => (p.text as string).trim())
      .filter(Boolean)
      .join("\n")
  })

  // Reset dismissed state whenever a new assistant text arrives
  createEffect(on(latestAssistantText, () => setPickerDismissed(false), { defer: true }))

  const pickerSpec = createMemo((): Spec | null => {
    if (pickerDismissed()) return null
    const text = latestAssistantText()
    if (!text) return null
    const compiler = createSpecStreamCompiler<Spec>()
    let hasPatches = false
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      // The compiler buffers until it sees a newline — append one so each
      // line is flushed immediately rather than waiting for the next push.
      const { newPatches } = compiler.push(trimmed + "\n")
      if (newPatches.length) hasPatches = true
    }
    return hasPatches ? compiler.getResult() : null
  })

  const aiSpecItems = createMemo(() => {
    const s = pickerSpec()
    if (!s) return []

    // Pattern 1: Direct Issue elements with literal string props
    const directIssues = (Object.values(s.elements as Record<string, any>))
      .filter((el) => el.type === "Issue" && typeof el.props?.id === "string" && typeof el.props?.title === "string")
      .map((el) => ({
        id: String(el.props.id),
        title: String(el.props.title),
        description: el.props?.description ? String(el.props.description) : undefined,
        status: String(el.props?.status ?? "open"),
        external_key: el.props?.external_key ? String(el.props.external_key) : undefined,
        provider_url: el.props?.provider_url ? String(el.props.provider_url) : undefined,
        selected: !!el.props?.selected,
        provider_meta: (el.props?.provider_meta as Record<string, unknown>) ?? {},
      }))

    if (directIssues.length > 0) return directIssues

    // Pattern 2: State-backed issues (AI used repeat/$item pattern — scan state arrays)
    const stateAny = (s as any).state
    if (!stateAny || typeof stateAny !== "object") return []
    for (const stateValue of Object.values(stateAny)) {
      if (!Array.isArray(stateValue) || !stateValue.length) continue
      const first = stateValue[0]
      if (typeof first !== "object" || !first || !("title" in first)) continue
      return (stateValue as any[]).map((item) => ({
        id: String(item.id ?? item.external_key ?? ""),
        title: String(item.title ?? ""),
        description: item.description ? String(item.description) : undefined,
        status: String(item.status ?? "open"),
        external_key: item.external_key ? String(item.external_key) : undefined,
        provider_url: item.provider_url ? String(item.provider_url) : undefined,
        selected: item.selected !== false,
        provider_meta: (item.provider_meta as Record<string, unknown>) ?? {},
      }))
    }

    return []
  })

  const pickerPreviewItems = createMemo((): WorkgraphPreview[] =>
    aiSpecItems().map((item) => ({
      id: item.id,
      provider: "github" as const,
      provider_meta: item.provider_meta,
      title: item.title,
      description: item.description ?? "",
      status: (item.status === "closed" ? "closed" : item.status === "in_progress" ? "in_progress" : "open") as "open" | "closed" | "in_progress",
      provider_url: item.provider_url ?? "",
      external_key: item.id,
    }))
  )

  const pickerAuth = createMemo((): import("../../utils/workgraph-api").WorkgraphAuthRequired | undefined => {
    const s = pickerSpec()
    if (!s) return undefined
    const authEl = Object.values(s.elements as Record<string, any>).find((el) => el.type === "Auth")
    return authEl?.props as import("../../utils/workgraph-api").WorkgraphAuthRequired | undefined
  })

  const tab = (run: { session_id: string | null; directory: string | null }) => {
    if (!run.session_id || !run.directory) return undefined
    return claxedo.topTabs.findSession(run.directory, run.session_id)
  }

  const sync = (run: { session_id: string | null; directory: string | null }) => {
    if (!run.session_id || !run.directory) return undefined
    return globalSync.child(run.directory, { bootstrap: false })[0]
  }

  const attention = (item: WorkgraphItem) => {
    const store = sync(item)
    if (store && item.session_id) {
      return (store.permission[item.session_id] ?? []).length > 0
    }
    return !!tab(item)?.attention
  }

  const working = (item: WorkgraphItem) => {
    const store = sync(item)
    if (store && item.session_id) {
      const status = store.session_status[item.session_id]
      return status?.type === "busy" || status?.type === "retry"
    }
    return !!tab(item)?.loading
  }
  const label = (item: WorkgraphItem) => tone(item, attention(item), working(item))
  const color = (item: WorkgraphItem) => dot(item, attention(item), working(item))
  const ready = createMemo(() => items().filter((item) => item.ready))
  const active = createMemo(() =>
    items().filter((item) => working(item) || item.status === "in_progress" || !!item.active_run_id),
  )
  const blocked = createMemo(() => items().filter((item) => item.blocked))
  const done = createMemo(() => items().filter((item) => item.status === "done"))
  const peers = createMemo(() => {
    const info = detail()
    const item = current()
    if (!info || !item) return ready()
    const ids = new Set([...info.blockers.map((node) => node.item_id), ...info.dependents.map((node) => node.item_id), item.item_id])
    return ready().filter((node) => !ids.has(node.item_id))
  })
  const note = (item: WorkgraphItem) => {
    const info = graph()[item.item_id]
    if (item.node_type === "mission") {
      const count = info?.children.length ?? 0
      const open = info?.descendants.filter((child) => child.status !== "done").length ?? 0
      return count
        ? `${count} child ${count === 1 ? "item" : "items"} under this mission. ${open} still need work.`
        : "Mission root for aggregated work."
    }
    const waits = info?.blockers.slice(0, 2).map((node) => node.title) ?? []
    if (waits.length) {
      const extra = item.blockers > waits.length ? ` +${item.blockers - waits.length}` : ""
      return `Waits on ${waits.join(", ")}${extra}.`
    }
    const next = info?.dependents.slice(0, 2).map((node) => node.title) ?? []
    if (next.length) {
      const extra = item.dependents > next.length ? ` +${item.dependents - next.length}` : ""
      return `Unblocks ${next.join(", ")}${extra}.`
    }
    if (item.ready) return "Ready to execute now, with no unmet blockers."
    if (item.status === "done") return "Completed and stored with its trace."
    if (item.description) return item.description
    return "Holding position in the shared graph."
  }

  // depth is still used in detail panel to show stage info
  const depth = createMemo(() => {
    const list = items()
    const by = new Map(list.map((item) => [item.item_id, item]))
    const memo = new Map<string, number>()
    const g = graph()
    const walk = (id: string, seen = new Set<string>()): number => {
      const found = memo.get(id)
      if (found !== undefined) return found
      if (seen.has(id)) return 0
      const item = by.get(id)
      if (!item) return 0
      const info = g[id]
      const waits = info?.blockers.filter((node) => by.has(node.item_id)).map((node) => node.item_id) ?? []
      const next = new Set(seen)
      next.add(id)
      const d = waits.length ? 1 + Math.max(...waits.map((dep) => walk(dep, next))) : item.blockers > 0 ? 1 : 0
      memo.set(id, d)
      return d
    }
    const map = new Map<string, number>()
    for (const item of list) map.set(item.item_id, walk(item.item_id))
    return map
  })

  const refresh = async () => {
    const [nextItems, nextSlices, nextRepos] = await Promise.all([
      workgraphApi.items(query()),
      workgraphApi.slices(repoRef() === "__all__" ? undefined : repoRef()),
      workgraphApi.repos(),
    ])
    setItems(nextItems)
    setSlices(nextSlices)
    setRepos(nextRepos)
    const id = selected()
    if (id && !nextItems.some((item) => item.item_id === id)) {
      setSelected(undefined)
      setDetail(undefined)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      await refresh()
      setErr(undefined)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const loadDetail = async (id: string) => {
    try {
      setDetail(await workgraphApi.item(id))
      setErr(undefined)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  onMount(() => {
    const saved = window.sessionStorage.getItem(SLICE_KEY)
    if (saved) setSliceId(saved)
    const repo = window.sessionStorage.getItem(REPO_KEY)
    if (repo) {
      setRepoRef(repo)
      setRepoSeed(true)
    }
    void load()
    const timer = window.setInterval(() => {
      void refresh()
      const id = selected()
      if (id) void loadDetail(id)
    }, 4000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(on([query, repoRef], () => {
    void load()
  }))

  createEffect(() => {
    const id = sliceId()
    if (!id) {
      window.sessionStorage.removeItem(SLICE_KEY)
      return
    }
    window.sessionStorage.setItem(SLICE_KEY, id)
  })

  createEffect(() => {
    const next = repoRef()
    if (!next || next === "__all__") {
      window.sessionStorage.removeItem(REPO_KEY)
      return
    }
    window.sessionStorage.setItem(REPO_KEY, next)
  })

  createEffect(() => {
    if (sliceId()) return
    if (items().length) return
    if (runId()) return
    if (search().trim()) return
    if (mode() !== "all") return
    const next = slices()
      .filter((item) => item.status === "draft" || item.status === "planning" || item.status === "planned" || item.status === "failed")
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]
    if (!next) return
    setSliceId(next.slice_id)
  })

  createEffect(() => {
    const id = sliceId()
    if (!id) return
    if (slices().some((item) => item.slice_id === id)) return
    setSliceId("")
  })

  createEffect(() => {
    if (repoSeed()) return
    const root = dir()
    if (!root) return
    const hit = repos().find((item) => item.bindings.some((row) => root === row.project_root || root.startsWith(`${row.project_root}/`)))
    setRepoSeed(true)
    if (!hit) return
    setRepoRef(hit.repo_ref ?? "__unbound__")
  })

  createEffect(() => {
    const id = selected()
    if (!id) return
    void loadDetail(id)
  })

  createEffect(() => {
    if (!dockDir()) return
    if (intakeId()) return
    void spawn().catch((e) => {
      const msg = (e as Error).message
      setErr(msg)
      showToast({ title: "Failed to start intake", description: msg, variant: "error" })
    })
  })

  createEffect(() => {
    const items = aiSpecItems()
    if (!items.length) return
    setPickerChecked(new Set(items.filter((item) => item.selected && item.id).map((item) => item.id)))
  })

  createEffect(() => {
    const item = slice()
    if (!item?.trace_run_id) {
      setSliceTrace([])
      return
    }
    void workgraphApi.sliceEvents(item.slice_id)
      .then((events) => setSliceTrace(events))
      .catch(() => {})
  })

  createEffect(() => {
    const info = detail()
    if (!info) return
    setGraph((prev) => ({ ...prev, [info.item.item_id]: info }))
  })

  createEffect(() => {
    const ids = items()
      .map((item) => item.item_id)
      .slice(0, 24)
    const next = ids.filter((id) => !graph()[id])
    if (!next.length) return
    void Promise.all(next.map(async (id) => [id, await workgraphApi.item(id)] as const))
      .then((list) => {
        setGraph((prev) => ({ ...prev, ...Object.fromEntries(list) }))
      })
      .catch(() => {})
  })

  const pick = (id: string) => {
    if (selected() === id) { setSelected(undefined); return }
    setSelected(id)
    setShowTrace(false)
    setDetailTab("overview")
  }

  const openLive = async (
    run:
      | WorkgraphRun
      | WorkgraphItem
      | { session_id: string | null; pty_id: string | null; directory: string | null; worktree_path: string | null },
  ) => {
    const dir = run.worktree_path || run.directory
    if (!dir) return
    if (run.session_id) {
      const existing = claxedo.topTabs.findSession(dir, run.session_id)
      const id = existing?.id ?? claxedo.topTabs.addSession(dir, run.session_id, "WorkGraph Session")
      if (!id) return
      claxedo.topTabs.setActive(id)
      return
    }
    if (run.pty_id) {
      const existing = claxedo.topTabs.findTerminal(dir, run.pty_id)
      const id = existing?.id ?? claxedo.topTabs.addTerminal(dir, run.pty_id, "WorkGraph Terminal")
      if (!id) return
      claxedo.topTabs.setActive(id)
      return
    }
    const list = await workgraphApi.sessions(dir).catch(() => [])
    const next = list
      .filter((item) => item.directory === dir)
      .sort((a, b) => b.time.updated - a.time.updated)[0]
    if (next) {
      const existing = claxedo.topTabs.findSession(dir, next.id)
      const id = existing?.id ?? claxedo.topTabs.addSession(dir, next.id, next.title || "WorkGraph Session")
      if (!id) return
      claxedo.topTabs.setActive(id)
      return
    }
    showToast({
      title: "No live session found",
      description: "This attempt does not have an attachable live session. Retry the task to create a fresh session-backed attempt.",
      variant: "error",
    })
  }

  const stamp = (text?: string | null) => fmt(text)
  const labs = (info: WorkgraphDetail) => info.item.labels ?? []
  const pads = (info: WorkgraphDetail) => info.scratchpads ?? []
  const arts = (info: WorkgraphDetail) => info.artifacts ?? []
  const childs = (info: WorkgraphDetail) => info.children ?? []
  const descs = (info: WorkgraphDetail) => info.descendants ?? []
  const synth = (info: WorkgraphDetail) => info.synthesis
  const synthArt = (info: WorkgraphDetail) => info.synthesis_artifact
  const missionArts = (info: WorkgraphDetail) => info.descendant_artifacts ?? []
  const missionPads = (info: WorkgraphDetail) => info.descendant_scratchpads ?? []
  const tries = (info: WorkgraphDetail) => info.attempts ?? []
  const logs = (info: WorkgraphDetail) => info.trace ?? []
  const blks = (info: WorkgraphDetail) => info.blockers ?? []
  const deps = (info: WorkgraphDetail) => info.dependents ?? []
  const slcs = (info: WorkgraphDetail) => info.slices ?? []

  const attemptLine = (run: WorkgraphDetail["attempts"][number]) => {
    const text = [run.status, run.runtime_type]
    if (run.finished_at) text.push(`finished ${stamp(run.finished_at)}`)
    if (!run.finished_at) text.push(`started ${stamp(run.started_at)}`)
    return text.join(" · ")
  }
  const reset = () => {
    setPickerChecked(new Set<string>())
    setPickerDismissed(true)
  }
  const scoped = () => repoRef() !== "__all__"
  const target = (repo?: string | null) => {
    const item = bucket(repo ?? (repoRef() === "__all__" ? null : repoRef()))
    if (!item?.repo_ref) return undefined
    return {
      repo_ref: item.repo_ref,
      repo_label: item.repo_label,
    }
  }
  const runDir = (repo?: string | null) => bind(repo)

  const client = () => {
    const root = dockDir()
    if (!root) throw new Error("No workspace available for WorkGraph intake")
    return {
      dir: root,
      client: globalSDK.createClient({
        directory: root,
        throwOnError: true,
      }),
    }
  }

  const spawn = async () => {
    const existing = intakeId()
    if (existing) return existing
    const sdk = client()
    const created = await sdk.client.session.create({
      title: "WorkGraph Intake",
    })
    const id = created.data?.id
    if (!id) throw new Error("Failed to create intake session")
    globalSync.child(sdk.dir)
    setIntakeId(id)
    return id
  }

  const plan = async (id?: string) => {
    const next = id || slice()?.slice_id
    if (!next) return
    setBusy(true)
    try {
      await workgraphApi.plan(next, runDir(slice()?.repo_ref))
      await refresh()
      showToast({ title: "Planning started", description: "WorkGraph is building the task graph." })
    } catch (e) {
      const msg = (e as Error).message
      setErr(msg)
      showToast({ title: "Failed to build graph", description: msg, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const lineFor = (id?: string) => {
    const store = intakeStore()
    const root = dockDir()
    if (!store || !root || !id) return ""
    return extractPromptFromParts(store.part[id] ?? [], {
      directory: root,
      attachmentName: "Attachment",
    })
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .trim()
  }

  const handoff = async (text?: string) => {
    const body = text?.trim() || lineFor(undefined)
    if (!body) return
    setBusy(true)
    try {
      const sdk = client()
      const created = await sdk.client.session.create({
        title: "Session",
      })
      const id = created.data?.id
      if (!id) throw new Error("Failed to create session")
      const tab = claxedo.topTabs.addSession(sdk.dir, id, "Session")
      if (tab) claxedo.topTabs.setActive(tab)
      await sdk.client.session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text: body }],
      })
      setErr(undefined)
      reset()
    } catch (e) {
      const msg = (e as Error).message
      setErr(msg)
      showToast({ title: "Failed to open session", description: msg, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const ingest = async (input: {
    kind?: "spec" | "doc"
    title?: string
    goal?: string
    content: string
    next_action: "stop_after_ingest" | "plan_graph"
  }) => {
    setBusy(true)
    try {
      const next = await workgraphApi.ingest({
        kind: input.kind || "spec",
        title: input.title?.trim() || undefined,
        goal: input.goal?.trim() || undefined,
        content: input.content.trim(),
        repo_ref: target()?.repo_ref,
        repo_label: target()?.repo_label,
        directory: dockDir(),
      })
      setSliceId(next.slice_id)
      setSelected(undefined)
      await refresh()
      if (input.next_action === "plan_graph") await plan(next.slice_id)
      showToast({
        title: input.next_action === "plan_graph" ? "Slice hydrated and planning" : "Slice hydrated",
        description:
          input.next_action === "plan_graph"
            ? "WorkGraph is building the task graph."
            : "The slice is ready. Build the graph when you're ready.",
      })
      setErr(undefined)
      reset()
    } catch (e) {
      const msg = (e as Error).message
      setErr(msg)
      showToast({ title: "Failed to ingest slice", description: msg, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const importFromSpec = async () => {
    const checked = pickerChecked()
    const allItems = aiSpecItems()
    const selected = allItems.filter((item) => checked.has(item.id))
    if (!selected.length) {
      showToast({ title: "Nothing selected", description: "Pick at least one issue to import.", variant: "error" })
      return
    }

    // Derive repo_ref from external_key ("owner/repo#number" → "github:owner/repo").
    // Validate that all selected items belong to the same repo before hitting the API.
    const repoFromKey = (key: string) => {
      const m = key.match(/^([^#]+)#\d+$/)
      return m ? m[1].toLowerCase() : null
    }
    const inferredRepos = new Set(
      selected.map((item) => repoFromKey(item.external_key ?? item.id)).filter(Boolean),
    )
    if (inferredRepos.size > 1) {
      showToast({
        title: "Multiple repos selected",
        description: "All selected issues must belong to the same repository. Deselect issues from other repos and try again.",
        variant: "error",
      })
      return
    }
    const inferredSlug = inferredRepos.size === 1 ? [...inferredRepos][0]! : null
    const repoRef = target()?.repo_ref ?? (inferredSlug ? `github:${inferredSlug}` : undefined)
    const repoLabel = target()?.repo_label ?? inferredSlug ?? undefined

    setBusy(true)
    try {
      const next = await workgraphApi.importProvider({
        provider: "github",
        mode: "project_or_team",
        query: {},
        repo_ref: repoRef,
        repo_label: repoLabel,
        directory: dockDir(),
        items: selected.map((item) => {
          // The GitHub adapter needs { owner, repo, issueNumber } in provider_meta
          // to call hydrateIssue. When the AI generates items, provider_meta is
          // empty {}. Parse owner/repo/number from external_key ("owner/repo#123").
          const keyMeta = (() => {
            const key = item.external_key ?? item.id
            const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/)
            if (!m) return {}
            return { owner: m[1], repo: m[2], issueNumber: Number(m[3]) }
          })()
          return {
            provider_meta: { ...keyMeta, ...item.provider_meta },
            title: item.title,
            provider_url: item.provider_url,
            external_key: item.external_key ?? item.id,
          }
        }),
      })
      if (next.kind === "auth_required") {
        showToast({ title: "Authentication required", description: next.message, variant: "error" })
        return
      }
      setSliceId(next.slice.slice_id)
      setSelected(next.mission.item_id)
      await refresh()
      await loadDetail(next.mission.item_id)
      showToast({ title: "Import complete", description: "The imported batch is now open as a mission." })
      setImportErr(undefined)
      reset()
    } catch (e) {
      const msg = (e as Error).message
      setImportErr(msg)
      showToast({ title: "Failed to import", description: msg, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const run = async (item?: WorkgraphItem) => {
    const root = runDir(item?.repo_ref ?? slice()?.repo_ref)
    if (!root) {
      showToast({
        title: "Local checkout required",
        description: "Pick a bound local project for this repo before starting execution.",
        variant: "error",
      })
      return
    }
    setBusy(true)
    try {
      const next = await workgraphApi.run(
        item
          ? { root_item_id: item.item_id, directory: root }
          : {
              slice_id: sliceId() || undefined,
              run_id: runId() || undefined,
              directory: root,
              status: mode() === "attention" ? undefined : mode(),
              search: search().trim() || undefined,
            },
      )
      await refresh()
      if (item?.item_id) await loadDetail(item.item_id)
      if (!next.created) {
        const description = next.blocked.length
          ? `${next.blocked.length} blocker${next.blocked.length === 1 ? "" : "s"} are outside the current focus.`
          : "Selected work is still blocked or already active."
        showToast({ title: "Nothing runnable yet", description, variant: "error" })
        return
      }
      const description = item
        ? next.blocked.length
          ? `${next.ready_ids.length} task${next.ready_ids.length === 1 ? "" : "s"} started. ${next.blocked.length} outside blocker${next.blocked.length === 1 ? "" : "s"} remain.`
          : `${next.ready_ids.length} task${next.ready_ids.length === 1 ? "" : "s"} in this focus are now executing.`
        : `${next.ready_ids.length} task${next.ready_ids.length === 1 ? "" : "s"} are now executing.`
      showToast({ title: item ? "Focused run started" : "Run started", description })
    } catch (e) {
      const msg = (e as Error).message
      setErr(msg)
      showToast({ title: "Failed to start run", description: msg, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const toggleItem = (id: string) => {
    setCollapsedItems((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Build hierarchy tree from parent_id
  const tree = createMemo((): TreeNode[] => {
    const list = items()
    if (!list.length) return []

    const byId = new Map(list.map((i) => [i.item_id, i]))
    const childrenOf = new Map<string | null, string[]>()
    for (const item of list) {
      const parent = item.parent_id && byId.has(item.parent_id) ? item.parent_id : null
      const bucket = childrenOf.get(parent) ?? []
      bucket.push(item.item_id)
      childrenOf.set(parent, bucket)
    }

    const visited = new Set<string>()

    // Sort items by status priority without reading reactive signals
    const statusPriority = (i: WorkgraphItem) => {
      if (i.status === "in_progress" || i.active_run_id) return 0
      if (i.ready) return 1
      if (i.blocked) return 2
      if (i.status === "done") return 3
      return 4
    }

    function buildNode(id: string): TreeNode | null {
      const item = byId.get(id)
      if (!item || visited.has(id)) return null
      visited.add(id)
      const childIds = childrenOf.get(id) ?? []
      return {
        item,
        children: childIds
          .map(buildNode)
          .filter((n): n is TreeNode => n !== null)
          .sort((a, b) => statusPriority(a.item) - statusPriority(b.item) || a.item.title.localeCompare(b.item.title)),
      }
    }

    const roots = (childrenOf.get(null) ?? [])
      .map((id) => byId.get(id))
      .filter((item): item is WorkgraphItem => !!item)
      .sort((a, b) => statusPriority(a) - statusPriority(b) || a.title.localeCompare(b.title))

    const result = roots.map((r) => buildNode(r.item_id)).filter((n): n is TreeNode => n !== null)

    // Anything whose graph data hasn't arrived yet: append as orphan roots
    for (const item of list) {
      if (!visited.has(item.item_id)) {
        const node = buildNode(item.item_id)
        if (node) result.push(node)
      }
    }

    return result
  })

  // Flatten the tree respecting collapsed state.
  // Default: expanded at depth < 2, collapsed at depth >= 2.
  // collapsedItems is an override set — presence flips the default for that node.
  const flatTree = createMemo((): FlatNode[] => {
    const result: FlatNode[] = []
    const overrides = collapsedItems()

    function flatten(nodes: TreeNode[], treeDepth: number) {
      for (const node of nodes) {
        const hasChildren = node.children.length > 0
        result.push({ item: node.item, treeDepth, hasChildren })
        if (!hasChildren) continue
        const defaultCollapsed = treeDepth >= 2
        const toggled = overrides.has(node.item.item_id)
        const isCollapsed = defaultCollapsed ? !toggled : toggled
        if (!isCollapsed) flatten(node.children, treeDepth + 1)
      }
    }

    flatten(tree(), 0)
    return result
  })

  const repoSections = createMemo(() => {
    if (repoRef() !== "__all__") {
      return [{
        key: repoRef(),
        bucket: currentRepo(),
        nodes: flatTree(),
      }]
    }
    const map = new Map<string, FlatNode[]>()
    for (const node of flatTree()) {
      const key = node.item.repo_ref ?? "__unbound__"
      const list = map.get(key) ?? []
      list.push(node)
      map.set(key, list)
    }
    return Array.from(map.entries())
      .map(([key, nodes]) => ({
        key,
        bucket: bucket(key === "__unbound__" ? null : key),
        nodes,
      }))
      .sort((a, b) => (a.bucket?.repo_label ?? a.key).localeCompare(b.bucket?.repo_label ?? b.key))
  })

  // Stable-identity memos for <For> to avoid full unmount/remount on every poll update.
  // repoSections() always returns new objects → <For> would unmount all rows, clamp scrollTop to 0.
  // Using string keys (stable by ===) lets <For> reconcile without touching the DOM.
  const sectionKeys = createMemo(() => repoSections().map(s => s.key))
  const sectionDataMap = createMemo(() => new Map(repoSections().map(s => [s.key, s])))
  const nodeDataMap = createMemo(() => new Map(flatTree().map(n => [n.item.item_id, n])))

  return (
    <div class="relative flex size-full min-h-0 flex-col overflow-hidden bg-background-base text-text-base [&_button]:cursor-pointer">


      {/* ── Body ── */}
      <div class="flex min-h-0 flex-1 overflow-hidden">

        {/* Task tree — centered, narrows when detail panel opens */}
        <div class="flex-1 overflow-y-auto" style="overflow-anchor: none">

          <div class="mx-auto w-full px-5 pb-64 md:max-w-200 2xl:max-w-[1000px]">

            {/* ── Page title (Notion-style) ── */}
            <div style="margin-top: 40px; margin-bottom: 16px;">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h1 style="font-size: 32px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; color: var(--text-strong); margin: 0;">WorkGraph</h1>
                  <p style="font-size: 13px; color: var(--text-weaker); margin-top: 4px;">
                    {repoRef() === "__all__"
                      ? `${repos().length} repo${repos().length === 1 ? "" : "s"} · ${items().length} ${items().length === 1 ? "task" : "tasks"}`
                      : `${currentRepo()?.repo_label ?? "Repo"} · ${items().length} ${items().length === 1 ? "task" : "tasks"}`}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2 pt-1">
                  <select
                    value={repoRef()}
                    class="h-7 max-w-56 rounded-md border border-border-weak-base bg-surface-base/50 px-2.5 text-12 text-text-base outline-none focus:border-border-strong focus:bg-surface-base"
                    onChange={(e) => {
                      setRepoRef(e.currentTarget.value)
                      setSliceId("")
                      setSelected(undefined)
                    }}
                  >
                    <option value="__all__">All repos</option>
                    <For each={repos()}>
                      {(item) => (
                        <option value={item.repo_ref ?? "__unbound__"}>
                          {item.repo_label} ({item.item_count})
                        </option>
                      )}
                    </For>
                  </select>
                  <input
                    value={search()}
                    onInput={(e) => setSearch(e.currentTarget.value)}
                    placeholder="Search tasks…"
                    class="h-7 w-40 rounded-md border border-border-weak-base bg-surface-base/50 px-2.5 text-12 text-text-base outline-none placeholder:text-text-weaker focus:border-border-strong focus:bg-surface-base"
                  />
                </div>
              </div>

            </div>

            <Show when={repoRef() !== "__all__" && currentRepo()}>
              {(item) => (
                <div class="mb-4 rounded-md border border-border-weak-base bg-surface-base/40 px-4 py-3 text-12 text-text-weaker">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div class="text-text-base">{item().repo_label}</div>
                      <div class="mt-0.5">
                        {item().bindings.length
                          ? `${item().bindings.length} local binding${item().bindings.length === 1 ? "" : "s"} available`
                          : "No local checkout is bound yet. Planning can still happen, but execution needs a local project."}
                      </div>
                    </div>
                    <Show when={item().bindings.length > 1}>
                      <select
                        value={bind(item().repo_ref)}
                        class="h-7 max-w-64 rounded-md border border-border-weak-base bg-background-base px-2.5 text-12 text-text-base outline-none focus:border-border-strong"
                        onChange={(e) =>
                          setRepoDir((prev) => ({
                            ...prev,
                            [item().repo_ref ?? "__unbound__"]: e.currentTarget.value,
                          }))}
                      >
                        <For each={item().bindings}>
                          {(row) => (
                            <option value={row.project_root}>
                              {row.project_name || row.project_root}
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                  </div>
                </div>
              )}
            </Show>

            {/* ── Filter bar ── */}
            <div class="pb-4">
              <div class="flex flex-wrap items-center gap-x-1 gap-y-1">
                <FilterButton active={mode() === "all"} label="All" onClick={() => setMode("all")} />
                <FilterButton active={mode() === "ready"} label="Ready" onClick={() => setMode("ready")} />
                <FilterButton active={mode() === "active"} label="Active" onClick={() => setMode("active")} />
                <FilterButton active={mode() === "attention"} label="Attention" onClick={() => setMode("attention")} />
                <FilterButton active={mode() === "blocked"} label="Blocked" onClick={() => setMode("blocked")} />
                <FilterButton active={mode() === "done"} label="Done" onClick={() => setMode("done")} />
                <button
                  type="button"
                  class="px-2 py-1 text-12 transition-colors"
                  style={{ visibility: filtered() ? "visible" : "hidden" }}
                  onClick={() => { setMode("all"); setSliceId(""); setRunId(""); setSearch(""); setSelected(undefined) }}
                >
                  Clear
                </button>
              </div>
            </div>

            {/* ── Slice banner ── */}
            <Show when={slice()}>
              {(item) => (
                <div class="mb-4 rounded-md border border-border-weak-base bg-surface-base/60 px-4 py-3">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="min-w-0">
                      <span class="text-12-medium text-text-strong">{item().title}</span>
                      <span class="ml-2 text-[11px] text-text-weaker">
                        {item().provider ? `${item().provider} import` : item().kind} · {item().status} · Updated {fmt(item().updated_at)}
                        <Show when={item().trace_run_id}> · {sliceTrace().length} events</Show>
                      </span>
                      <Show when={item().error}>
                        <div class="mt-0.5 text-[11px] text-icon-critical-base">{item().error}</div>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <Button size="small" variant="secondary" onClick={() => setSelected(undefined)}>
                        Inspect
                      </Button>
                      <Show when={item().status === "planning"}>
                        <span class="font-mono text-[10px] text-text-weaker">planning…</span>
                      </Show>
                      <Show when={item().session_id || item().pty_id || item().worktree_path || item().directory}>
                        <Button size="small" variant="secondary" onClick={() => openLive(item())}>
                          Open Planning Work
                        </Button>
                      </Show>
                      <Show when={repoRef() === "__all__"}>
                        <span class="text-[11px] text-text-weaker">Choose one repo to build or run work.</span>
                      </Show>
                      <Show when={repoRef() !== "__all__" && item().status !== "planning" && (item().status === "draft" || item().status === "failed" || sliceItems().length === 0)}>
                        <Button size="small" loading={busy()} onClick={() => void plan()}>Build Graph</Button>
                      </Show>
                      <Show when={repoRef() !== "__all__" && item().status !== "planning" && sliceItems().length > 0}>
                        <Button size="small" variant="secondary" loading={busy()} onClick={() => void run()}>Run Ready Work</Button>
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </Show>

            {/* ── Error ── */}
            <Show when={err()}>
              <div class="mb-4 rounded-md border border-icon-critical-base/20 bg-icon-critical-base/5 px-4 py-2 text-12 text-icon-critical-base">
                {err()}
              </div>
            </Show>

            <Show when={loading() && !items().length}>
              <div class="flex min-h-[260px] items-center justify-center text-12 text-text-weak">Loading…</div>
            </Show>

            <Show when={!loading() && !items().length}>
              <div class="flex min-h-[320px] flex-col items-center justify-center gap-3 text-center">
                <Icon name="dot-grid" size="large" class="text-icon-weak-base" />
                <div class="text-13-medium text-text-strong">No tasks in this view</div>
                <div class="max-w-[400px] text-12 text-text-weak">
                  <Show when={sliceId()} fallback="Ingest a slice to seed the graph, then build it into tasks.">
                    The selected slice still needs to be built into graph tasks.
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={items().length}>
              <div>
                <For each={sectionKeys()}>
                  {(sectionKey) => {
                    const section = () => sectionDataMap().get(sectionKey)!
                    const nodeIds = createMemo(() => (sectionDataMap().get(sectionKey)?.nodes ?? []).map(n => n.item.item_id))
                    return (
                    <div class="mb-4">
                      <Show when={repoRef() === "__all__"}>
                        <div class="sticky top-0 z-[1] border-b border-border-weak-base bg-background-base/95 px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-text-weaker backdrop-blur">
                          {section().bucket?.repo_label ?? "Unbound"}
                        </div>
                      </Show>
                      <For each={nodeIds()}>
                        {(itemId) => {
                          const node = () => nodeDataMap().get(itemId)!
                          return (
                          <div
                            class="group flex w-full cursor-pointer items-stretch border-b border-border-weak-base transition-colors hover:bg-surface-base-hover"
                            classList={{ "bg-surface-base-hover": selected() === itemId }}
                          >
                            <div style={{ width: `${node().treeDepth * 20}px`, "flex-shrink": "0" }} />
                            <div class="flex w-6 shrink-0 items-center justify-center">
                              <Show
                                when={node().hasChildren}
                                fallback={<div class="h-px w-2.5 rounded-full bg-border-weak-base" />}
                              >
                                <button
                                  type="button"
                                  class="flex h-full w-full items-center justify-center text-[9px] text-text-weaker transition-colors hover:text-text-base"
                                  onClick={() => toggleItem(itemId)}
                                >
                                  <span
                                    class="inline-block transition-transform duration-150"
                                    classList={{
                                      "rotate-90": node().treeDepth >= 2
                                        ? collapsedItems().has(itemId)
                                        : !collapsedItems().has(itemId),
                                    }}
                                  >
                                    ▶
                                  </span>
                                </button>
                              </Show>
                            </div>
                            <button
                              type="button"
                              class="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left"
                              onClick={() => pick(itemId)}
                            >
                              <div class="min-w-0 flex-1">
                                <div class="truncate text-12 text-text-base group-hover:text-text-strong">
                                  {node().item.title}
                                </div>
                                <Show when={node().item.blocked && graph()[itemId]?.blockers[0]}>
                                  <div class="mt-0.5 truncate text-[11px] text-text-weaker">
                                    blocked by{" "}
                                    <span class="text-text-weak">{graph()[itemId]!.blockers[0]!.title}</span>
                                    <Show when={node().item.blockers > 1}> +{node().item.blockers - 1}</Show>
                                  </div>
                                </Show>
                              </div>
                              <Show when={node().item.runtime_type}>
                                <span class="shrink-0 font-mono text-[10px] text-text-weaker">{node().item.runtime_type}</span>
                              </Show>
                            </button>
                            {/* Row-level hover actions */}
                            <div class="flex shrink-0 items-center gap-1 pr-3">
                              <Show when={node().item.ready && repoRef() !== "__all__"}>
                                <button
                                  type="button"
                                  class="invisible rounded px-1.5 py-0.5 text-[10px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base group-hover:visible"
                                  onClick={() => void run(node().item)}
                                >
                                  Run
                                </button>
                              </Show>
                              <Show when={node().item.session_id || node().item.pty_id || node().item.worktree_path || node().item.directory}>
                                <button
                                  type="button"
                                  class="invisible rounded px-1.5 py-0.5 text-[10px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base group-hover:visible"
                                  onClick={() => void openLive(node().item)}
                                >
                                  Live
                                </button>
                              </Show>
                              <Show when={node().item.provider_url}>
                                <a
                                  href={node().item.provider_url!}
                                  target="_blank"
                                  rel="noreferrer"
                                  class="invisible rounded px-1.5 py-0.5 text-[10px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base group-hover:visible"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  ↗
                                </a>
                              </Show>
                              <div class="h-2 w-2 shrink-0 rounded-full" style={{ background: color(node().item) }} />
                            </div>
                          </div>
                          )
                        }}
                      </For>
                    </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>

        {/* ── Detail panel (slides in from right) ── */}
        <div
          class="shrink-0 overflow-hidden bg-background-base transition-all duration-200"
          style={{
            width: selected() || showSlice() ? "380px" : "0px",
            "border-left": selected() || showSlice() ? "1px solid var(--border-weak-base)" : "none",
          }}
        >
          <div class="h-full w-[380px] overflow-y-auto">
            <Show when={showSlice() && slice()}>
              {(item) => (
                <div class="flex flex-col p-4 pb-10">
                  <div class="mb-1 flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="mb-1.5 flex items-center gap-2">
                        <div class="h-2 w-2 shrink-0 rounded-full bg-[var(--icon-info-base)]" />
                        <span class="font-mono text-[10px] text-text-weaker">
                          {(item().provider ? `${item().provider} import` : item().kind).toUpperCase()} · {item().status}
                        </span>
                      </div>
                      <h2 class="text-13-medium text-text-strong">{item().title}</h2>
                      <p class="mt-1.5 text-12 text-text-base">
                        {item().goal}
                      </p>
                    </div>
                    <button
                      type="button"
                      class="mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-12 text-text-weaker transition-colors hover:bg-surface-base-hover hover:text-text-base"
                      onClick={() => setSliceId("")}
                    >
                      ×
                    </button>
                  </div>

                  <div class="mt-3 flex items-center gap-2">
                    <Show when={item().status === "draft" || item().status === "failed" || sliceItems().length === 0}>
                      <Button size="small" loading={busy()} onClick={() => void plan()}>Build Graph</Button>
                    </Show>
                    <Show when={item().status !== "planning" && sliceItems().length > 0}>
                      <Button size="small" variant="secondary" loading={busy()} onClick={() => void run()}>Run Ready Work</Button>
                    </Show>
                    <Show when={item().session_id || item().pty_id || item().worktree_path || item().directory}>
                      <Button size="small" variant="secondary" onClick={() => openLive(item())}>Open Planning Work</Button>
                    </Show>
                  </div>

                  <Show when={item().content}>
                    <div class="mt-4 border-t border-border-weak-base pt-4">
                      <RichBlock title="Source brief" text={item().content} tone="accent" meta={`${item().kind} slice`} />
                    </div>
                  </Show>

                  <div class="mt-4 border-t border-border-weak-base pt-4">
                    <div class="mb-2 flex items-center justify-between">
                      <div class="text-[10px] uppercase tracking-[0.12em] text-text-weaker">Planning activity</div>
                      <div class="text-[10px] text-text-weaker">{sliceTrace().length} events</div>
                    </div>
                    <Show when={sliceTrace().length} fallback={<p class="text-12 text-text-weaker">No planning activity yet.</p>}>
                      <div class="flex flex-col gap-2">
                        <For each={sliceTrace().slice(-10).reverse()}>
                          {(event) => {
                            const info = line(event)
                            return (
                              <div class="rounded-md border border-border-weak-base bg-background-base/50 px-3 py-2">
                                <div class="flex items-center justify-between gap-3">
                                  <span class="text-[11px] font-medium text-text-base">{info.title}</span>
                                  <span class="text-[10px] text-text-weaker">{fmt(event.created_at)}</span>
                                </div>
                                <Show when={info.body}>
                                  <p class="mt-1.5 text-[11px] leading-5 text-text-weak">{info.body}</p>
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <Show
              when={selected() && !detail()}
              fallback={
                <Show when={panel()}>
                  {(info) => {
                    const isMission = () => info().item.node_type === "mission"
                    const allArts = () => isMission() ? missionArts(info()) : arts(info())
                    const allPads = () => isMission() ? missionPads(info()) : pads(info())
                    const hasArtifacts = () => allArts().length > 0 || allPads().length > 0
                    const hasDeps = () => !isMission() && (blks(info()).length > 0 || deps(info()).length > 0)
                    const hasHistory = () => !isMission() && (tries(info()).length > 0 || logs(info()).length > 0 || slcs(info()).length > 0 || !!(info().item.session_id || info().item.pty_id || info().item.worktree_path || info().item.directory))

                    return (
                      <div class="flex h-full flex-col">

                        {/* Sticky header + tabs */}
                        <div class="shrink-0 border-b border-border-weak-base bg-background-base px-4 pt-4 pb-0">
                          {/* Title row */}
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                              <div class="mb-1 flex items-center gap-2">
                                <div class="h-2 w-2 shrink-0 rounded-full" style={{ background: color(info().item) }} />
                                <span class="text-[10px] text-text-weaker">
                                  {isMission() ? "Mission" : `Stage ${String((depth().get(info().item.item_id) ?? 0) + 1).padStart(2, "0")}`}
                                  {" · "}
                                  <span style={{ color: color(info().item) }}>{label(info().item)}</span>
                                </span>
                              </div>
                              <h2 class="text-13-medium leading-snug text-text-strong">{info().item.title}</h2>
                            </div>
                            <div class="mt-0.5 flex shrink-0 items-center gap-0.5">
                              <button
                                type="button"
                                class="rounded px-1.5 py-0.5 text-[11px] text-text-weaker transition-colors hover:bg-icon-critical-base/10 hover:text-icon-critical-base"
                                title="Delete"
                                onClick={async () => {
                                  if (isMission() && childs(info()).length > 0) {
                                    const open = childs(info()).filter((c) => c.status !== "done")
                                    if (open.length > 0) {
                                      showToast({ title: "Cannot delete mission", description: `${open.length} child task${open.length !== 1 ? "s" : ""} must be completed or deleted first.`, variant: "error" })
                                      return
                                    }
                                  }
                                  if (!confirm(`Delete "${info().item.title}"?`)) return
                                  setBusy(true)
                                  try {
                                    await workgraphApi.deleteItem(info().item.item_id)
                                    setSelected(undefined)
                                    await refresh()
                                  } catch (e) {
                                    setErr((e as Error).message)
                                    showToast({ title: "Could not delete", description: (e as Error).message, variant: "error" })
                                  } finally {
                                    setBusy(false)
                                  }
                                }}
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                class="rounded px-1.5 py-0.5 text-12 text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base"
                                onClick={() => setSelected(undefined)}
                              >
                                ×
                              </button>
                            </div>
                          </div>

                          {/* Action buttons */}
                          <div class="mt-3 flex items-center gap-2">
                            <Show when={isMission() || info().item.ready}>
                              <Button size="small" loading={busy()} onClick={() => void run(info().item)}>
                                Start Focused Run
                              </Button>
                            </Show>
                            <Show when={info().item.session_id || info().item.pty_id || info().item.worktree_path || info().item.directory}>
                              <Button size="small" variant="secondary" onClick={() => openLive(info().item)}>
                                Open Live Work
                              </Button>
                            </Show>
                            <Show when={info().item.provider_url}>
                              <a
                                href={info().item.provider_url!}
                                target="_blank"
                                rel="noreferrer"
                                class="rounded px-2 py-1 text-[11px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base"
                              >
                                ↗ Source
                              </a>
                            </Show>
                          </div>

                          {/* Tab bar */}
                          <div class="mt-3 flex gap-0.5">
                            {(["overview", "artifacts", "history"] as const).map((tab) => (
                              <button
                                type="button"
                                onClick={() => setDetailTab(tab)}
                                classList={{
                                  "relative px-2.5 py-1.5 text-12 transition-colors capitalize": true,
                                  "text-text-strong after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-text-strong after:content-['']": detailTab() === tab,
                                  "text-text-weaker hover:text-text-base": detailTab() !== tab,
                                }}
                              >
                                {tab}
                                <Show when={tab === "artifacts" && hasArtifacts()}>
                                  <span class="ml-1 rounded bg-surface-base px-1 py-px text-[9px] text-text-weaker">
                                    {allArts().length + allPads().length}
                                  </span>
                                </Show>
                                <Show when={tab === "history" && hasHistory()}>
                                  <span class="ml-1 rounded bg-surface-base px-1 py-px text-[9px] text-text-weaker">
                                    {tries(info()).length || ""}
                                  </span>
                                </Show>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Scrollable tab content */}
                        <div class="flex-1 overflow-y-auto">

                          {/* ── OVERVIEW TAB ── */}
                          <Show when={detailTab() === "overview"}>
                            <div class="flex flex-col gap-4 p-4 pb-10">

                              {/* Inline stats */}
                              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-weaker">
                                <Show when={isMission()}>
                                  <span>{childs(info()).length} child{childs(info()).length !== 1 ? "ren" : ""}</span>
                                  <span class="text-border-weak-base">·</span>
                                  <span>{descs(info()).filter((d) => d.status !== "done").length} open</span>
                                  <Show when={missionArts(info()).length}>
                                    <span class="text-border-weak-base">·</span>
                                    <span>{missionArts(info()).length} output{missionArts(info()).length !== 1 ? "s" : ""}</span>
                                  </Show>
                                </Show>
                                <Show when={!isMission()}>
                                  <Show when={tries(info()).length}>
                                    <span>{tries(info()).length} attempt{tries(info()).length !== 1 ? "s" : ""}</span>
                                    <span class="text-border-weak-base">·</span>
                                  </Show>
                                  <span>{arts(info()).length} artifact{arts(info()).length !== 1 ? "s" : ""}</span>
                                </Show>
                                <Show when={labs(info()).length}>
                                  <span class="text-border-weak-base">·</span>
                                  <For each={labs(info())}>
                                    {(lbl) => <span class="rounded bg-surface-base/60 px-1.5 py-px">{lbl}</span>}
                                  </For>
                                </Show>
                              </div>

                              {/* Description / brief */}
                              <Show when={info().item.description}>
                                <RichBlock
                                  title={isMission() ? "Mission brief" : "Task brief"}
                                  text={info().item.description}
                                />
                              </Show>

                              {/* Synthesis (missions) */}
                              <Show when={isMission() && (synthArt(info()) || synth(info()))}>
                                <div>
                                  <div class="mb-2 text-[10px] uppercase tracking-[0.12em] text-text-weaker">Synthesis</div>
                                  <Show
                                    when={synthArt(info())}
                                    fallback={
                                      <div class="rounded-lg border border-border-weak-base bg-background-base/50 px-3 py-2.5">
                                        <div class="text-12 text-text-base">{synth(info())?.title ?? "Synthesis node ready"}</div>
                                        <div class="mt-1 text-[11px] text-text-weaker">No consolidated report yet.</div>
                                      </div>
                                    }
                                  >
                                    {(artifact) => (
                                      <RichBlock
                                        title={synth(info())?.title ?? "Synthesis"}
                                        text={artifact().content}
                                        meta={fmt(artifact().created_at)}
                                        tone="accent"
                                      />
                                    )}
                                  </Show>
                                </div>
                              </Show>

                              {/* Child work (missions) */}
                              <Show when={isMission() && childs(info()).length}>
                                <div>
                                  <div class="mb-2 text-[10px] uppercase tracking-[0.12em] text-text-weaker">Child work</div>
                                  <div class="flex flex-col gap-0.5">
                                    <For each={childs(info())}>
                                      {(child) => (
                                        <button
                                          type="button"
                                          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-base"
                                          onClick={() => pick(child.item_id)}
                                        >
                                          <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color(child) }} />
                                          <span class="min-w-0 flex-1 truncate text-12 text-text-base">{child.title}</span>
                                          <span class="shrink-0 font-mono text-[10px] text-text-weaker">{child.status}</span>
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </Show>

                              {/* Dependencies (tasks only) */}
                              <Show when={hasDeps()}>
                                <div>
                                  <div class="mb-2 flex gap-1">
                                    <button
                                      type="button"
                                      onClick={() => setDepsTab("waits")}
                                      classList={{
                                        "px-2.5 py-1 rounded text-12 transition-colors": true,
                                        "bg-surface-base text-text-strong": depsTab() === "waits",
                                        "text-text-weaker hover:text-text-base": depsTab() !== "waits",
                                      }}
                                    >
                                      Waits on{" "}
                                      <span class="ml-0.5 text-[10px]">{blks(info()).length}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDepsTab("unlocks")}
                                      classList={{
                                        "px-2.5 py-1 rounded text-12 transition-colors": true,
                                        "bg-surface-base text-text-strong": depsTab() === "unlocks",
                                        "text-text-weaker hover:text-text-base": depsTab() !== "unlocks",
                                      }}
                                    >
                                      Unlocks{" "}
                                      <span class="ml-0.5 text-[10px]">{deps(info()).length}</span>
                                    </button>
                                  </div>
                                  <Show when={depsTab() === "waits"}>
                                    <Show
                                      when={blks(info()).length}
                                      fallback={<p class="text-12 text-text-weaker">No blockers — task is ready.</p>}
                                    >
                                      <div class="flex flex-col gap-0.5">
                                        <For each={blks(info())}>
                                          {(b) => (
                                            <button
                                              type="button"
                                              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-base"
                                              onClick={() => pick(b.item_id)}
                                            >
                                              <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color(b) }} />
                                              <span class="min-w-0 flex-1 truncate text-12 text-text-base">{b.title}</span>
                                              <span class="shrink-0 font-mono text-[10px] text-text-weaker">{b.status}</span>
                                            </button>
                                          )}
                                        </For>
                                      </div>
                                    </Show>
                                  </Show>
                                  <Show when={depsTab() === "unlocks"}>
                                    <Show
                                      when={deps(info()).length}
                                      fallback={<p class="text-12 text-text-weaker">No dependents.</p>}
                                    >
                                      <div class="flex flex-col gap-0.5">
                                        <For each={deps(info())}>
                                          {(d) => (
                                            <button
                                              type="button"
                                              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-base"
                                              onClick={() => pick(d.item_id)}
                                            >
                                              <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color(d) }} />
                                              <span class="min-w-0 flex-1 truncate text-12 text-text-base">{d.title}</span>
                                              <span class="shrink-0 font-mono text-[10px] text-text-weaker">{d.status}</span>
                                            </button>
                                          )}
                                        </For>
                                      </div>
                                    </Show>
                                  </Show>
                                </div>
                              </Show>

                            </div>
                          </Show>

                          {/* ── ARTIFACTS TAB ── */}
                          <Show when={detailTab() === "artifacts"}>
                            <div class="flex flex-col gap-3 p-4 pb-10">
                              <Show
                                when={hasArtifacts()}
                                fallback={
                                  <div class="flex flex-col items-center justify-center py-12 text-center">
                                    <div class="text-12 text-text-weaker">No artifacts yet</div>
                                    <div class="mt-1 text-[11px] text-text-weaker/60">
                                      Outputs will appear here after the task runs.
                                    </div>
                                  </div>
                                }
                              >
                                <Show when={allArts().length}>
                                  <For each={allArts()}>
                                    {(artifact) => (
                                      <RichBlock
                                        title={artifact.type}
                                        text={artifact.content}
                                        meta={fmt(artifact.created_at)}
                                        tone="accent"
                                        noLimit
                                      />
                                    )}
                                  </For>
                                </Show>
                                <Show when={allPads().length}>
                                  <Show when={allArts().length}>
                                    <div class="text-[10px] uppercase tracking-[0.12em] text-text-weaker/60">Scratchpads</div>
                                  </Show>
                                  <For each={allPads()}>
                                    {(pad) => (
                                      <RichBlock
                                        title={pad.priority}
                                        text={pad.content}
                                        meta={fmt(pad.createdAt)}
                                        noLimit
                                      />
                                    )}
                                  </For>
                                </Show>
                              </Show>
                            </div>
                          </Show>

                          {/* ── HISTORY TAB ── */}
                          <Show when={detailTab() === "history"}>
                            <div class="flex flex-col gap-4 p-4 pb-10">

                              {/* Live session */}
                              <Show when={!isMission() && (info().item.session_id || info().item.pty_id || info().item.worktree_path || info().item.directory)}>
                                <div class="flex items-center justify-between gap-3 rounded-lg border border-border-weak-base bg-background-base/50 px-3 py-2.5">
                                  <div class="flex items-center gap-2">
                                    <div class="h-1.5 w-1.5 rounded-full bg-[var(--icon-success-base)]" />
                                    <span class="text-12 text-text-base">{info().item.attempt_status ?? "active"}</span>
                                  </div>
                                  <Button size="small" variant="secondary" onClick={() => openLive(info().item)}>
                                    Open
                                  </Button>
                                </div>
                              </Show>

                              {/* Attempts */}
                              <Show when={!isMission() && tries(info()).length}>
                                <div>
                                  <div class="mb-2 text-[10px] uppercase tracking-[0.12em] text-text-weaker">Attempts</div>
                                  <div class="flex flex-col gap-1.5">
                                    <For each={tries(info())}>
                                      {(r) => (
                                        <div class="flex items-center justify-between gap-3 rounded-lg border border-border-weak-base bg-background-base/50 px-3 py-2">
                                          <div class="min-w-0">
                                            <div class="text-12 text-text-base">{attemptLine(r)}</div>
                                            <div class="mt-0.5 font-mono text-[10px] text-text-weaker/70">
                                              #{r.attempt_id.slice(-6)} · run {r.run_id.slice(-6)}
                                            </div>
                                          </div>
                                          <Show when={r.session_id || r.pty_id || r.worktree_path || r.directory}>
                                            <Button size="small" variant="secondary" onClick={() => openLive(r)}>Open</Button>
                                          </Show>
                                        </div>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </Show>

                              {/* Provenance */}
                              <Show when={slcs(info()).length}>
                                <div>
                                  <div class="mb-2 text-[10px] uppercase tracking-[0.12em] text-text-weaker">Source slices</div>
                                  <div class="flex flex-col gap-1.5">
                                    <For each={slcs(info())}>
                                      {(sl) => (
                                        <div class="rounded-lg border border-border-weak-base bg-background-base/50 px-3 py-2">
                                          <div class="flex items-center justify-between gap-2">
                                            <span class="min-w-0 truncate text-12 text-text-base">{sl.title}</span>
                                            <span class="shrink-0 rounded bg-surface-base/60 px-1.5 py-px text-[9px] text-text-weaker">{sl.status}</span>
                                          </div>
                                          <div class="mt-0.5 text-[10px] text-text-weaker/60">{sl.kind} · {fmt(sl.updated_at)}</div>
                                        </div>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              </Show>

                              {/* Trace (collapsible) */}
                              <Show when={!isMission() && logs(info()).length}>
                                <div>
                                  <button
                                    type="button"
                                    class="mb-2 flex w-full items-center justify-between text-[10px] uppercase tracking-[0.12em] text-text-weaker transition-colors hover:text-text-base"
                                    onClick={() => setShowTrace((v) => !v)}
                                  >
                                    <span>Trace · {logs(info()).length} events</span>
                                    <span class="text-[10px]">{showTrace() ? "▲" : "▼"}</span>
                                  </button>
                                  <Show when={showTrace()}>
                                    <div class="flex flex-col gap-1.5">
                                      <For each={logs(info()).slice().reverse()}>
                                        {(event) => {
                                          const ev = line(event)
                                          return (
                                            <div class="rounded-lg border border-border-weak-base bg-background-base/50 px-3 py-2">
                                              <div class="flex items-center justify-between gap-3">
                                                <span class="text-[11px] font-medium text-text-base">{ev.title}</span>
                                                <span class="shrink-0 text-[10px] text-text-weaker">{fmt(event.created_at)}</span>
                                              </div>
                                              <Show when={ev.body}>
                                                <p class="mt-1 text-[11px] leading-5 text-text-weak">{ev.body}</p>
                                              </Show>
                                            </div>
                                          )
                                        }}
                                      </For>
                                    </div>
                                  </Show>
                                </div>
                              </Show>

                              <Show when={!hasHistory()}>
                                <div class="flex flex-col items-center justify-center py-12 text-center">
                                  <div class="text-12 text-text-weaker">No history yet</div>
                                </div>
                              </Show>

                            </div>
                          </Show>

                        </div>
                      </div>
                    )
                  }}
                </Show>
              }
            >
              <div class="flex h-32 items-center justify-center text-12 text-text-weak">Loading task…</div>
            </Show>
          </div>
        </div>

      </div>

      <div
        class="pointer-events-none absolute bottom-0 left-0 z-20 flex justify-center px-4 pb-4 transition-[right] duration-200"
        style={{ right: selected() || showSlice() ? "380px" : "0px" }}
      >
        <div class="pointer-events-auto flex w-full max-w-3xl flex-col items-center gap-3">

          {/* Issue picker — rendered above the dock so it's not clipped */}
          <Show when={pickerSpec() !== null && (pickerPreviewItems().length > 0 || !!pickerAuth())}>
            <div class="w-full">
              <WorkgraphIssuePicker
                auth={pickerAuth()}
                items={pickerPreviewItems()}
                checked={pickerChecked()}
                next="stop_after_ingest"
                mode="project_or_team"
                provider="github"
                loading={busy()}
                onToggle={(id) =>
                  setPickerChecked((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }
                onSelectAll={() => setPickerChecked(new Set(pickerPreviewItems().map((item) => workgraphPickerKey(item))))}
                onClear={() => setPickerChecked(new Set<string>())}
                onImport={() => void importFromSpec()}
                onDismiss={() => setPickerDismissed(true)}
              />
            </div>
          </Show>

          <Show when={importErr()}>
            <div class="w-full rounded-xl border border-icon-critical-base/20 bg-icon-critical-base/5 px-4 py-3 text-12 text-icon-critical-base">
              {importErr()}
            </div>
          </Show>

          <Show
            when={dir() && intakeId()}
            fallback={
              <div class="w-full rounded-[14px] border border-border-base bg-background-stronger px-4 py-5 text-center text-12 text-text-weaker shadow-lg shadow-black/15">
                Starting intake session…
              </div>
            }
          >
            <DirectoryScope directory={dir()!}>
              <IntakeDock
                id={intakeId()!}
                hideMessages={pickerSpec() !== null}
                onSubmit={() => {
                  setErr(undefined)
                  setImportErr(undefined)
                  reset()
                }}
              />
            </DirectoryScope>
          </Show>
        </div>
      </div>
    </div>
  )
}
