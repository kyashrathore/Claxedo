import { For, Show, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type {
  WorkgraphAuthRequired,
  WorkgraphPreview,
  WorkgraphProvider,
  WorkgraphQueryMode,
} from "../../utils/workgraph-api"

function key(item: WorkgraphPreview) {
  return item.external_key || JSON.stringify(item.provider_meta)
}

function modeLabel(mode: WorkgraphQueryMode) {
  return String(mode || "").replaceAll("_", " ")
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
  onDismiss?: () => void
}

export { key as workgraphPickerKey }

export function WorkgraphIssuePicker(props: WorkgraphIssuePickerProps) {
  const selectedCount = createMemo(() => props.checked.size)

  if (props.auth) {
    return (
      <div class="overflow-hidden rounded-xl border border-border-weak-base bg-background-base/60 px-4 py-3">
        <div class="text-[10px] uppercase tracking-[0.12em] text-text-weaker">Authentication</div>
        <div class="mt-1 text-13-medium text-text-strong">
          {props.auth.provider === "github" ? "GitHub" : "Linear"} access needed
        </div>
        <div class="mt-2 text-12 leading-6 text-text-base">{String(props.auth.message || "")}</div>
        <Show when={props.auth.hint}>
          <div class="mt-1 text-[11px] leading-5 text-text-weaker">{String(props.auth.hint)}</div>
        </Show>
      </div>
    )
  }

  if (!props.items.length) {
    return (
      <div class="overflow-hidden rounded-xl border border-border-weak-base bg-background-base/60 px-4 py-3">
        <div class="text-13-medium text-text-strong">No issues matched</div>
        <div class="mt-1 text-12 text-text-weaker">
          Try a broader query or change the provider request.
        </div>
      </div>
    )
  }

  return (
    <div class="overflow-hidden rounded-xl border border-border-weak-base bg-background-base/60">
      {/* Header row — provider info + actions */}
      <div class="flex items-center justify-between gap-3 border-b border-border-weak-base/50 px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="text-12-medium text-text-strong">
            {props.provider === "github" ? "GitHub" : "Linear"}
          </span>
          <span class="text-[10px] text-text-weaker">{modeLabel(props.mode)}</span>
          <span class="rounded-md bg-surface-base/60 px-1.5 py-0.5 text-[10px] text-text-weak">
            {props.items.length} issue{props.items.length === 1 ? "" : "s"}
          </span>
          <span class="text-[10px] text-text-weaker/70">
            {selectedCount()}/{props.items.length} selected
          </span>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-[10px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base"
            onClick={() => props.onSelectAll()}
          >
            Select all
          </button>
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-[10px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base"
            onClick={() => props.onClear()}
          >
            Clear
          </button>
          <Button size="small" loading={!!props.loading} onClick={() => props.onImport()}>
            Import
          </Button>
          <Show when={props.onDismiss}>
            <button
              type="button"
              class="ml-1 rounded px-1.5 py-0.5 text-[11px] text-text-weaker transition-colors hover:bg-surface-base hover:text-text-base"
              onClick={() => props.onDismiss?.()}
            >
              ✕
            </button>
          </Show>
        </div>
      </div>

      {/* Scrollable issue list */}
      <div class="max-h-[240px] overflow-y-auto">
        <For each={props.items}>
          {(item) => {
            const id = key(item)
            return (
              <button
                type="button"
                class="flex w-full items-start gap-2.5 border-b border-border-weak-base/30 px-3 py-2 text-left transition-colors last:border-0 hover:bg-surface-base/20"
                onClick={() => props.onToggle(id)}
              >
                <input
                  type="checkbox"
                  class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--surface-interactive-base)]"
                  checked={props.checked.has(id)}
                  readOnly
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-12 text-text-strong">{item.title}</span>
                    <span class="shrink-0 rounded px-1 py-px text-[9px] text-text-weaker ring-1 ring-inset ring-border-weak-base/60">
                      {item.status}
                    </span>
                    <Show when={item.aggregate_only}>
                      <span class="shrink-0 rounded px-1 py-px text-[9px] text-text-weaker ring-1 ring-inset ring-border-weak-base/60">
                        aggregate
                      </span>
                    </Show>
                  </div>
                  <Show when={item.description}>
                    <div class="mt-0.5 line-clamp-1 text-[11px] leading-4 text-text-weaker">
                      {item.description}
                    </div>
                  </Show>
                  <div class="mt-0.5 flex items-center gap-2 text-[10px] text-text-weaker/60">
                    <Show when={item.external_key}>
                      <span class="font-mono">{item.external_key}</span>
                    </Show>
                    <Show when={item.parent_external_key}>
                      <span>↳ {item.parent_external_key}</span>
                    </Show>
                    <Show when={item.provider_url}>
                      <a
                        href={String(item.provider_url)}
                        target="_blank"
                        rel="noreferrer"
                        class="underline decoration-border-base/40 underline-offset-2 hover:text-text-weak"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↗
                      </a>
                    </Show>
                  </div>
                </div>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
