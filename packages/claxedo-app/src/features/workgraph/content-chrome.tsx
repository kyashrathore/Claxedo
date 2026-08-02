import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { List } from "@opencode-ai/ui/list"
import { Popover } from "@opencode-ai/ui/popover"
import { createSignal, For, type Accessor, type JSX } from "solid-js"
import { WorkGraphApiError } from "./api"

/** Presentational chrome for the WorkGraph screen — tabs, summary strip, chip
 *  menus, loading/empty states, and the shared error banner. Stateless apart
 *  from local open/close signals; every domain decision stays in the content. */

export type WorkGraphPanelBridge = {
  mode: () => "attention" | "settings" | "tasks" | undefined
  isOpen: () => boolean
  identity: () => unknown
  open: (view: "attention" | "settings" | "tasks") => void
  close: () => void
  headerSlot: Accessor<HTMLElement | null>
  bodySlot: Accessor<HTMLElement | null>
}

export function PanelTab(props: { active: boolean; onClick: () => void; children: JSX.Element; ref?: (element: HTMLButtonElement) => void }) {
  return (
    <button
      ref={props.ref}
      type="button"
      role="tab"
      aria-selected={props.active}
      class="flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors"
      classList={{
        "bg-surface-base text-text-strong": props.active,
        "text-text-base hover:bg-surface-base-hover hover:text-text-base": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function StatStrip(props: { stats: Array<{ label: string; value: number | string }> }) {
  return (
    <div class="workgraph-summary" aria-label="WorkGraph summary">
      <For each={props.stats}>
        {(stat) => (
          <div class="workgraph-stat">
            <span class="workgraph-stat-value text-text-strong">{stat.value}</span>
            <span class="workgraph-stat-label text-text-weaker">{stat.label}</span>
          </div>
        )}
      </For>
    </div>
  )
}

/** The Stream base-revision chip: a compact trigger whose popover reuses the same
 *  shared `List` (search box + keyed items) as the session composer's model picker
 *  so the styling matches exactly. Typing filters the advertised revisions; clicking
 *  a revision selects it; Enter accepts the raw typed text so any Git ref stays
 *  enterable even when it matches no advertised option. */
export function BaseRevisionChip(props: { value: string; options: readonly string[]; onChange: (value: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const revisions = () => [...props.options]
  const commit = (value: string) => {
    const next = value.trim()
    if (next) props.onChange(next)
    setOpen(false)
  }
  // The shared List builds its own search box (magnifier + TextField) but exposes
  // no aria-label hook. Label the rendered search input directly so it keeps the
  // stable "Base revision" accessible name the vitest/e2e specs rely on (the
  // placeholder shows the current value, so it can't double as the name).
  const labelSearchInput = (host: HTMLElement) => {
    queueMicrotask(() => host.querySelector<HTMLElement>("input, textarea")?.setAttribute("aria-label", "Base revision"))
  }
  return (
    <Popover
      placement="bottom-start"
      portal
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        // Open with an empty query so the full revision list is visible; the List
        // remounts fresh on each open, so its filter always starts empty.
        if (next) setDraft("")
      }}
      class="workgraph-revision-popover"
      style={{ "z-index": "400" }}
      trigger={
        <>
          <span class="workgraph-defchip-value">{props.value || "HEAD"}</span>
          <Icon name="chevron-down" size="small" class="workgraph-chip-caret" />
        </>
      }
      triggerAs="button"
      triggerProps={{ type: "button", class: "workgraph-chip-trigger", "aria-label": "Base revision" }}
    >
      <div class="workgraph-revision-list-host" ref={labelSearchInput}>
        <List<string>
          class="workgraph-revision-list"
          search={{ placeholder: props.value || "HEAD", autofocus: true }}
          key={(revision) => revision}
          items={revisions}
          current={props.value || undefined}
          emptyMessage="No advertised revisions"
          onFilter={setDraft}
          onKeyEvent={(event) => {
            // Any Git ref stays enterable: Enter commits the raw typed text even
            // when it matches no advertised option, falling back to the current
            // value when the field is empty. Preventing default stops the List
            // from selecting its highlighted row instead.
            if (event.key !== "Enter" || event.isComposing) return
            event.preventDefault()
            commit(draft() || props.value)
          }}
          onSelect={(revision) => {
            if (revision) commit(revision)
          }}
        >
          {(revision) => <span class="workgraph-revision-option">{revision}</span>}
        </List>
      </div>
    </Popover>
  )
}

export function LoadingState() {
  return (
    <div class="space-y-3" aria-live="polite" aria-label="Loading WorkGraph">
      <For each={[1, 2, 3]}>{() => <div class="h-12 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />}</For>
    </div>
  )
}

export function EmptyState(props: { title: string; copy: string }) {
  return (
    <div class="workgraph-panel col-span-full py-12 text-center">
      <div class="mx-auto mb-4 grid size-10 place-items-center rounded-full border border-border-weak-base bg-surface-base">
        <Icon name="dot-grid" size="small" class="text-icon-weak-base" />
      </div>
      <h2 class="text-[14px] font-medium text-text-strong">{props.title}</h2>
      <p class="mx-auto mt-1 max-w-md text-[11px] leading-5 text-text-weaker">{props.copy}</p>
    </div>
  )
}

export function StatusBanner(props: { error: WorkGraphApiError; retry: () => void; retryLabel?: string }) {
  const copy = () => (props.error.kind === "unauthorized" || props.error.kind === "forbidden" ? "You do not have access to this WorkGraph." : props.error.kind === "conflict" ? "This work changed elsewhere. Reload before trying again." : props.error.kind === "offline" ? "WorkGraph is offline. Your existing view is preserved while we reconnect." : props.error.kind === "cursor_invalid" ? "WorkGraph changed while you were away. A fresh snapshot is required." : props.error.message)
  return (
    <div class="mb-6 flex items-center justify-between gap-4 border-y border-border-weak-base bg-background-stronger px-3 py-2 text-[12px]" role="alert">
      <span>{copy()}</span>
      <Button size="small" variant="ghost" onClick={props.retry}>
        {props.retryLabel ?? (props.error.kind === "offline" ? "Reconnect" : "Reload")}
      </Button>
    </div>
  )
}

export function normalizeError(error: unknown) {
  return error instanceof WorkGraphApiError ? error : new WorkGraphApiError("request_failed", error instanceof Error ? error.message : String(error))
}

// Resolves after the next animation frame — the point by which a closing modal
// dialog has performed its one deferred focus-restoration. Registered after the
// dialog's own frame, so focus work chained on this runs strictly afterwards.
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
