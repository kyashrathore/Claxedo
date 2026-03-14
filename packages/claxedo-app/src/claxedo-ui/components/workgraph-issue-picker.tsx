import { createMemo, Show, type JSX } from "solid-js"
import { ActionProvider, Renderer, StateProvider } from "@json-render/solid"
import { Button } from "@opencode-ai/ui/button"
import type {
  WorkgraphAuthRequired,
  WorkgraphPreview,
  WorkgraphProvider,
  WorkgraphQueryMode,
} from "../../utils/workgraph-api"

type Ctx = {
  props: Record<string, unknown>
  children?: JSX.Element
  emit: (event: string) => void
}

function key(item: WorkgraphPreview) {
  return item.external_key || JSON.stringify(item.provider_meta)
}

function registry() {
  return {
    Stack: (ctx: Ctx) => (
      <div class="flex flex-col" style={{ gap: String(ctx.props.gap || "12px") }}>
        {ctx.children}
      </div>
    ),
    Summary: (ctx: Ctx) => (
      <div class="rounded-xl border border-border-weak-base bg-background-base/80 px-4 py-3">
        <div class="text-[10px] uppercase tracking-[0.12em] text-text-weaker">Preview</div>
        <div class="mt-1 text-13-medium text-text-strong">
          {ctx.props.provider === "github" ? "GitHub" : "Linear"} · {String(ctx.props.mode || "").replaceAll("_", " ")}
        </div>
        <div class="mt-1 text-12 text-text-weaker">
          {String(ctx.props.count || 0)} match{ctx.props.count === 1 ? "" : "es"} · {String(ctx.props.selected || 0)} selected
        </div>
      </div>
    ),
    Next: (ctx: Ctx) => (
      <div class="rounded-xl border border-border-weak-base bg-surface-base/40 px-4 py-3 text-12 text-text-weaker">
        <span class="text-text-strong">
          {ctx.props.action === "plan_graph" ? "Import and build graph next." : "Import only."}
        </span>{" "}
        {ctx.props.action === "plan_graph"
          ? "The planner will start immediately after the import finishes."
          : "You can build the graph from the new slice when you're ready."}
      </div>
    ),
    Toolbar: (ctx: Ctx) => (
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-weak-base bg-background-base/60 px-4 py-3">
        <div class="text-12 text-text-weaker">
          {String(ctx.props.selected || 0)}/{String(ctx.props.total || 0)} selected
        </div>
        <div class="flex items-center gap-2">
          <Button size="small" variant="secondary" onClick={() => ctx.emit("select_all")}>
            Select all
          </Button>
          <Button size="small" variant="secondary" onClick={() => ctx.emit("clear")}>
            Clear
          </Button>
          <Button size="small" loading={!!ctx.props.loading} onClick={() => ctx.emit("import")}>
            Import selected
          </Button>
        </div>
      </div>
    ),
    Issue: (ctx: Ctx) => (
      <button
        type="button"
        class="flex w-full items-start gap-3 rounded-xl border border-border-weak-base bg-background-base/70 px-4 py-3 text-left transition-colors hover:bg-surface-base/70"
        onClick={() => ctx.emit("toggle")}
      >
        <input type="checkbox" class="mt-1" checked={!!ctx.props.selected} readOnly />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="truncate text-12 text-text-strong">{String(ctx.props.title || "")}</span>
            <span class="rounded border border-border-weak-base px-1.5 py-0.5 text-[10px] text-text-weaker">
              {String(ctx.props.status || "")}
            </span>
            <Show when={!!ctx.props.aggregate_only}>
              <span class="rounded border border-border-weak-base px-1.5 py-0.5 text-[10px] text-text-weaker">
                aggregate
              </span>
            </Show>
          </div>
          <Show when={ctx.props.description}>
            <div class="mt-1 line-clamp-2 text-[11px] leading-5 text-text-weaker">{String(ctx.props.description)}</div>
          </Show>
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-text-weaker">
            <Show when={ctx.props.external_key}>
              <span>{String(ctx.props.external_key)}</span>
            </Show>
            <Show when={ctx.props.parent_external_key}>
              <span>parent {String(ctx.props.parent_external_key)}</span>
            </Show>
            <Show when={ctx.props.provider_url}>
              <a
                href={String(ctx.props.provider_url)}
                target="_blank"
                rel="noreferrer"
                class="underline decoration-border-base underline-offset-2"
                onClick={(event) => event.stopPropagation()}
              >
                Open
              </a>
            </Show>
          </div>
        </div>
      </button>
    ),
    Auth: (ctx: Ctx) => (
      <div class="rounded-xl border border-border-weak-base bg-background-base/80 px-4 py-4">
        <div class="text-[10px] uppercase tracking-[0.12em] text-text-weaker">Authentication</div>
        <div class="mt-1 text-13-medium text-text-strong">
          {ctx.props.provider === "github" ? "GitHub" : "Linear"} access needed
        </div>
        <div class="mt-2 text-12 leading-6 text-text-base">{String(ctx.props.message || "")}</div>
        <div class="mt-2 text-[11px] leading-5 text-text-weaker">{String(ctx.props.hint || "")}</div>
      </div>
    ),
    Empty: (ctx: Ctx) => (
      <div class="rounded-xl border border-border-weak-base bg-background-base/80 px-4 py-4">
        <div class="text-13-medium text-text-strong">{String(ctx.props.title || "")}</div>
        <div class="mt-2 text-12 leading-6 text-text-weaker">{String(ctx.props.message || "")}</div>
      </div>
    ),
  }
}

function spec(input: {
  auth?: WorkgraphAuthRequired
  items: WorkgraphPreview[]
  checked: Set<string>
  next: "stop_after_ingest" | "plan_graph"
  mode: WorkgraphQueryMode
  provider: WorkgraphProvider
  loading?: boolean
}) {
  if (input.auth) {
    return {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "16px" },
          children: ["auth"],
        },
        auth: {
          type: "Auth",
          props: input.auth,
          children: [],
        },
      },
    }
  }
  if (!input.items.length) {
    return {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: { gap: "16px" },
          children: ["empty"],
        },
        empty: {
          type: "Empty",
          props: {
            title: "No issues matched",
            message: "Try a broader query or change the provider request.",
          },
          children: [],
        },
      },
    }
  }
  const elements: Record<string, any> = {
    root: {
      type: "Stack",
      props: { gap: "16px" },
      children: ["summary", "next", "toolbar", ...input.items.map((_, index) => `issue_${index}`)],
    },
    summary: {
      type: "Summary",
      props: {
        provider: input.provider,
        mode: input.mode,
        count: input.items.length,
        selected: input.checked.size,
      },
      children: [],
    },
    next: {
      type: "Next",
      props: { action: input.next },
      children: [],
    },
    toolbar: {
      type: "Toolbar",
      props: {
        total: input.items.length,
        selected: input.checked.size,
        loading: !!input.loading,
      },
      on: {
        select_all: { action: "select_all" },
        clear: { action: "clear" },
        import: { action: "import" },
      },
      children: [],
    },
  }
  input.items.forEach((item, index) => {
    const id = key(item)
    elements[`issue_${index}`] = {
      type: "Issue",
      props: {
        id,
        title: item.title,
        status: item.status,
        description: item.description,
        selected: input.checked.has(id),
        external_key: item.external_key,
        parent_external_key: item.parent_external_key ?? null,
        aggregate_only: !!item.aggregate_only,
        provider_url: item.provider_url,
      },
      on: {
        toggle: {
          action: "toggle",
          params: { id },
        },
      },
      children: [],
    }
  })
  return { root: "root", elements }
}

export type WorkgraphIssuePickerProps = {
  auth?: WorkgraphAuthRequired
  items: WorkgraphPreview[]
  checked: Set<string>
  next: "stop_after_ingest" | "plan_graph"
  mode: WorkgraphQueryMode
  provider: WorkgraphProvider
  loading?: boolean
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  onImport: () => void
}

export function WorkgraphIssuePicker(props: WorkgraphIssuePickerProps) {
  const view = createMemo(() =>
    spec({
      auth: props.auth,
      items: props.items,
      checked: props.checked,
      next: props.next,
      mode: props.mode,
      provider: props.provider,
      loading: props.loading,
    }),
  )

  return (
    <StateProvider initialState={{}}>
      <ActionProvider
        handlers={{
          toggle: async (params) => {
            const id = typeof params?.id === "string" ? params.id : ""
            if (!id) return
            props.onToggle(id)
          },
          select_all: async () => props.onSelectAll(),
          clear: async () => props.onClear(),
          import: async () => props.onImport(),
        }}
      >
        <Renderer spec={view() as any} registry={registry() as any} />
      </ActionProvider>
    </StateProvider>
  )
}
