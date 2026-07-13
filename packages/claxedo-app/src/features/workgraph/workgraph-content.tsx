import type { AttentionCursor, AttentionItem, AttemptDto, CommandResult, OutcomeDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Dialog as DialogRoot } from "@kobalte/core/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Dialog as DialogShell } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { RichTextEditor } from "@/ui/rich-text"
import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { createWorkGraphClient, WorkGraphApiError, type WorkGraphClient } from "./api"
import { syncWorkGraphChanges } from "./change-sync"
import { setWorkGraphAttentionCount } from "./waiting/attention-signal"
import { WaitingCard, createWaitingCardController } from "./waiting/waiting-card"
import { WaitingItemDialog } from "./waiting/item-dialogs"
import { WaitingPanelBody } from "./waiting/waiting-panel"
import { StreamSettingsDialog, WorkGraphSettingsView } from "./waiting/settings-dialogs"
import { waitingSourceFromClient } from "./waiting/waiting-source"
import { WorkGraphStreamTree } from "./workgraph-overview"
import "./workgraph.css"
import "./waiting/waiting.css"

/**
 * Bridge from the app shell to the one shared WorkspacePanel. WorkGraph is a
 * global-navigation surface bound to no workspace, so it drives that single
 * panel as global-navigation tabs and portals its "Needs you" / Settings views
 * into the panel slots. There is no second panel shell and no bespoke trigger.
 */
export type WorkGraphPanelBridge = {
  /** Selected WorkGraph panel tab, or undefined when the panel isn't in a WorkGraph mode. */
  mode: () => "attention" | "settings" | undefined
  /** Whether the shared panel is currently open in a WorkGraph mode. */
  isOpen: () => boolean
  open: (view: "attention" | "settings") => void
  close: () => void
  headerSlot: Accessor<HTMLElement | null>
  bodySlot: Accessor<HTMLElement | null>
}

export function WorkGraphContent(props: { request?: typeof fetch; client?: WorkGraphClient; panel?: WorkGraphPanelBridge }) {
  const client = props.client ?? createWorkGraphClient({ request: props.request })
  const source = waitingSourceFromClient(client)
  const [creating, setCreating] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [reconnecting, setReconnecting] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [environment, setEnvironment] = createSignal<"inherit" | "local_worktree" | "hosted_workspace">("inherit")
  const [integration, setIntegration] = createSignal<"inherit" | "manual" | "pull_request" | "direct">("inherit")
  const [mutationError, setMutationError] = createSignal<WorkGraphApiError>()
  const [syncError, setSyncError] = createSignal<WorkGraphApiError>()

  // Focused item dialog + per-stream settings dialog (focused, over this screen).
  const [selectedWaiting, setSelectedWaiting] = createSignal<AttentionItem>()
  const [streamSettings, setStreamSettings] = createSignal<StreamDto>()

  const closeCreating = () => {
    setCreating(false)
    setExpanded(false)
    setTitle("")
    setDescription("")
    setEnvironment("inherit")
    setIntegration("inherit")
  }
  const dismissCreating = (event: KeyboardEvent) => {
    if (!creating() || event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    closeCreating()
  }
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", dismissCreating, true)
    onCleanup(() => window.removeEventListener("keydown", dismissCreating, true))
  }

  const [snapshot, { refetch }] = createResource(() => client.snapshot())
  const [defaults] = createResource(() => client.defaults())

  // Attention ("Needs you") is sourced ONLY from the strict Attention endpoint and
  // paged explicitly: the first load fetches page one, "Load more" appends the next
  // page via nextCursor. It never reconstructs from the snapshot and never eagerly
  // loads every page.
  const [attentionItems, setAttentionItems] = createSignal<AttentionItem[]>([])
  const [attentionTotal, setAttentionTotal] = createSignal(0)
  const [attentionNextCursor, setAttentionNextCursor] = createSignal<AttentionCursor>()
  const [attentionLoading, setAttentionLoading] = createSignal(false)
  const [attentionLoaded, setAttentionLoaded] = createSignal(false)
  const [attentionError, setAttentionError] = createSignal<unknown>()
  const loadAttention = async (after?: AttentionCursor) => {
    if (attentionLoading()) return
    setAttentionLoading(true)
    if (!after) setAttentionError(undefined)
    try {
      const page = await source.waiting(after)
      setAttentionItems((prev) => (after ? [...prev, ...page.items] : page.items))
      setAttentionTotal(page.total)
      // Publish to the shared top-level toggle attention dot (strict Attention only).
      setWorkGraphAttentionCount(page.total)
      setAttentionNextCursor(page.hasMore ? page.nextCursor : undefined)
      setAttentionLoaded(true)
      setAttentionError(undefined)
    } catch (error) {
      setAttentionError(error)
    } finally {
      setAttentionLoading(false)
    }
  }
  onMount(() => void loadAttention())

  const records = createMemo(() => snapshot()?.records ?? [])
  const streams = createMemo(() => records().filter((record): record is StreamDto => record.recordType === "stream"))
  const attempts = createMemo(() => records().filter((record): record is AttemptDto => record.recordType === "attempt"))
  const workItems = createMemo(() => records().filter((record): record is WorkItemDto => record.recordType === "work_item"))
  const outcomes = createMemo(() => records().filter((record): record is OutcomeDto => record.recordType === "outcome"))
  const activeAttempts = createMemo(() => attempts().filter((attempt) => ["admitted", "placing", "running"].includes(attempt.state)))
  const sortedStreams = createMemo(() => [...streams()].sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt))

  const hasAttention = () => attentionTotal() > 0
  // Clear the shared top-level toggle attention when this surface unmounts; the
  // live total is published from loadAttention as each page resolves.
  onCleanup(() => setWorkGraphAttentionCount(0))
  const card = createWaitingCardController(attentionItems)
  const needsYouOpen = () => !!props.panel?.isOpen() && props.panel?.mode() === "attention"

  const retryMutation = () => {
    void refetch()
  }
  let syncedCursor: string | undefined
  createEffect(
    on(snapshot, (current) => {
      if (!current || current.snapshotCursor === syncedCursor) return
      syncedCursor = current.snapshotCursor
      // A change-sync failure means live updates stalled; surface it explicitly
      // rather than swallowing it, and let the user force a fresh snapshot.
      void syncWorkGraphChanges(client, current.snapshotCursor, refetch).then(
        () => setSyncError(undefined),
        (error) => setSyncError(normalizeError(error)),
      )
    }),
  )
  const mutate = async (action: () => Promise<CommandResult>) => {
    if (submitting()) return false
    setSubmitting(true)
    setMutationError()
    try {
      const result = await action()
      if (!result.ok) {
        const kind = result.error.code === "version_conflict" ? "conflict" : "request_failed"
        throw new WorkGraphApiError(kind, result.error.message)
      }
      await refetch()
      return true
    } catch (error) {
      setMutationError(normalizeError(error))
      return false
    } finally {
      setSubmitting(false)
    }
  }
  // Only the harness-independent knobs live here. Harness/model/agent/effort are
  // driven by the session harness system (@/features/session/*, which WorkGraph
  // can't import) and belong to a future shared harness selector, not fabricated
  // defaults.
  const createStream = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!title().trim()) return
    const summary = description().trim()
    const selectedEnvironment = environment()
    const selectedIntegration = integration()
    const execution: NonNullable<Parameters<typeof client.createStream>[0]["execution"]> = {
      ...(selectedEnvironment !== "inherit" ? { environment: { kind: selectedEnvironment } } : {}),
      ...(selectedIntegration !== "inherit" ? { integration: selectedIntegration } : {}),
    }
    const hasExecutionOverride = Object.keys(execution).length > 0
    if (!(await mutate(() => client.createStream({ title: title().trim(), ...(summary ? { description: summary } : {}), ...(hasExecutionOverride ? { execution } : {}) })))) return
    closeCreating()
  }
  const reconnect = async () => {
    setReconnecting(true)
    await refetch()
    setReconnecting(false)
  }

  const openPanelTab = (view: "attention" | "settings") => {
    if (view === "attention") card.markAllSeen()
    props.panel?.open(view)
  }
  const selectWaiting = (item: AttentionItem) => setSelectedWaiting(item)
  const resolvedWaiting = () => void loadAttention()

  const workgraphSettingsSource = {
    defaults: () => client.defaults(),
    saveDefaults: (expectedVersion: number, next: Parameters<typeof client.updateWorkGraphDefaults>[1]) => client.updateWorkGraphDefaults(expectedVersion, next),
  }
  // Atomic stream update: execution + recap saved in one command at one expected
  // version. Empty override objects clear the corresponding overrides.
  const streamSettingsSource = {
    workgraphDefaults: () => client.defaults(),
    save: (streamId: string, expectedVersion: number, settings: Parameters<typeof client.updateStreamSettings>[2]) => client.updateStreamSettings(streamId, expectedVersion, settings),
  }

  return (
    <main class="workgraph-shell workgraph-surface size-full overflow-hidden text-text-base" aria-label="WorkGraph">
      <div class="workgraph-scroll">
        <div class="workgraph-canvas mx-auto flex w-full max-w-[1240px] flex-col px-4 py-6 sm:px-8 md:px-10 md:py-10">
          <header class="workgraph-head">
            <div class="workgraph-head-top">
              <div class="min-w-0">
                <div class="workgraph-eyebrow text-text-weaker">
                  <span class="workgraph-mark" aria-hidden="true" /> WorkGraph
                </div>
                <h1 class="workgraph-title text-text-strong">Streams</h1>
              </div>
              <div class="flex flex-shrink-0 items-center gap-1.5">
                <div class="workgraph-head-controls">
                  <span class="workgraph-attention-control">
                    <IconButton
                      variant="ghost"
                      size="small"
                      icon="bullet-list"
                      aria-label={hasAttention() ? `Needs you — ${attentionTotal()} waiting on you` : "Needs you"}
                      onClick={() => openPanelTab("attention")}
                    />
                    <Show when={hasAttention()}>
                      <span class="workgraph-attention-dot workgraph-attention-control-dot" aria-hidden="true" />
                    </Show>
                  </span>
                  <IconButton variant="ghost" size="small" icon="sliders" aria-label="WorkGraph settings" onClick={() => openPanelTab("settings")} />
                </div>
                <Button size="small" icon="plus-small" variant="primary" onClick={() => setCreating(true)} aria-haspopup="dialog">
                  New stream
                </Button>
              </div>
            </div>
            <p class="workgraph-lede text-text-weak">Every thread of work you're shipping with AI. Expand a stream to see its outcomes and the tasks underneath.</p>
          </header>
          <div class="workgraph-rule" aria-hidden="true" />
          <DialogRoot
            modal
            open={creating()}
            onOpenChange={(open) => {
              if (open) return
              closeCreating()
            }}
          >
            <DialogRoot.Portal>
              <div class="workgraph-dialog-scope" classList={{ "is-expanded": expanded() }}>
                <DialogRoot.Overlay data-component="dialog-overlay" />
                <DialogShell
                  fit={!expanded()}
                  size={expanded() ? "large" : "normal"}
                  title="New stream"
                  onEscapeKeyDown={closeCreating}
                  action={
                    <div class="flex items-center gap-0.5">
                      <IconButton variant="ghost" size="small" icon={expanded() ? "collapse" : "expand"} aria-label={expanded() ? "Shrink dialog" : "Expand dialog"} onClick={() => setExpanded(!expanded())} />
                      <IconButton variant="ghost" size="small" icon="close" aria-label="Close" onClick={closeCreating} />
                    </div>
                  }
                >
                  <form
                    onSubmit={createStream}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        event.currentTarget.requestSubmit()
                      }
                    }}
                    class="workgraph-create-form"
                  >
                    <label for="workgraph-stream-title" class="sr-only">
                      What are you trying to ship?
                    </label>
                    <input
                      id="workgraph-stream-title"
                      autofocus
                      value={title()}
                      onInput={(event) => setTitle(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                          event.preventDefault()
                          event.currentTarget.closest("form")?.querySelector<HTMLElement>(".richtext-surface")?.focus()
                        }
                      }}
                      class="workgraph-create-title"
                      placeholder="Stream title"
                    />
                    <div class="workgraph-create-desc">
                      <RichTextEditor value={description()} onChange={setDescription} ariaLabel="Description" placeholder="Add a description…" />
                    </div>
                    <div class="workgraph-create-chips" role="group" aria-label="Stream defaults">
                      <ChipMenu
                        value={environment() === "inherit" ? `Inherit · ${defaults()?.defaults.execution.environment?.kind === "hosted_workspace" ? "Cloud" : defaults()?.defaults.execution.environment?.kind === "local_worktree" ? "Local" : "environment not set"}` : environment() === "local_worktree" ? "Override · Local" : "Override · Cloud"}
                        selected={environment()}
                        options={[
                          { value: "inherit", label: "Inherit WorkGraph environment" },
                          { value: "local_worktree", label: "Override · Local worktree" },
                          { value: "hosted_workspace", label: "Override · Cloud workspace" },
                        ]}
                        onSelect={setEnvironment}
                      />
                      <ChipMenu
                        value={integration() === "inherit" ? `Inherit · ${defaults()?.defaults.execution.integration === "pull_request" ? "Pull request" : defaults()?.defaults.execution.integration === "manual" ? "Manual" : defaults()?.defaults.execution.integration === "direct" ? "Direct" : "integration not set"}` : integration() === "pull_request" ? "Override · Pull request" : integration() === "manual" ? "Override · Manual" : "Override · Direct"}
                        selected={integration()}
                        options={[
                          { value: "inherit", label: "Inherit WorkGraph integration" },
                          { value: "pull_request", label: "Override · Pull request" },
                          { value: "manual", label: "Override · Manual" },
                          { value: "direct", label: "Override · Direct" },
                        ]}
                        onSelect={setIntegration}
                      />
                    </div>
                    <Show when={mutationError()}>{(error) => <StatusBanner error={error()} retry={retryMutation} />}</Show>
                    <div class="workgraph-create-actions">
                      <span class="workgraph-create-hint text-text-weaker">
                        <kbd>⌘</kbd> <kbd>↵</kbd> to create
                      </span>
                      <div class="flex gap-2">
                        <Button type="button" size="small" variant="ghost" onClick={closeCreating}>
                          Cancel
                        </Button>
                        <Button type="submit" size="small" variant="primary" disabled={!title().trim() || submitting()}>
                          {submitting() ? "Creating…" : "Create"}
                        </Button>
                      </div>
                    </div>
                  </form>
                </DialogShell>
              </div>
            </DialogRoot.Portal>
          </DialogRoot>
          <Show when={!creating() && mutationError()}>{(error) => <div class="workgraph-toast"><StatusBanner error={error()} retry={retryMutation} /></div>}</Show>
          <Show when={syncError()}>{(error) => <div class="workgraph-toast"><StatusBanner error={error()} retry={() => { setSyncError(undefined); void refetch() }} /></div>}</Show>
          <Show when={reconnecting()}>
            <div class="mb-6 border-y border-border-weak-base px-3 py-2 text-[12px] text-text-weak" role="status">
              Reconnecting to WorkGraph…
            </div>
          </Show>
          <Switch>
            <Match when={snapshot.loading && !snapshot()}>
              <LoadingState />
            </Match>
            <Match when={snapshot.error}>
              <StatusBanner error={normalizeError(snapshot.error)} retry={() => void reconnect()} />
            </Match>
            <Match when={true}>
              <div class="space-y-4">
                <StatStrip
                  stats={[
                    { label: "Active", value: streams().filter((stream) => stream.lifecycleState !== "closed").length },
                    { label: "Agents working", value: activeAttempts().length },
                    { label: "Needs you", value: attentionTotal() },
                  ]}
                />
                <WorkGraphStreamTree
                  streams={sortedStreams()}
                  outcomes={outcomes()}
                  items={workItems()}
                  attempts={attempts()}
                  empty={<EmptyState title="No streams yet" copy="Create one for the first outcome you want to ship." />}
                  relativeTime={relativeTime}
                  client={client}
                  mutate={mutate}
                  onOpenStreamSettings={setStreamSettings}
                />
              </div>
            </Match>
          </Switch>
        </div>
      </div>
      {/* Contextual "Needs you" card: only while attention exists AND the panel's
          Needs-you tab isn't already open. Nothing renders at zero attention. */}
      <Show when={card.visible(needsYouOpen())}>
        <WaitingCard items={attentionItems()} total={attentionTotal()} working={activeAttempts().length} onOpenPanel={() => openPanelTab("attention")} onDismiss={card.markAllSeen} onSelect={selectWaiting} />
      </Show>
      {/* The two WorkGraph tabs + the active view live in the one shared panel. */}
      <Show when={props.panel}>
        {(panel) => (
          <>
            <Show when={panel().headerSlot()}>
              {(slot) => (
                <Portal mount={slot()}>
                  <div class="flex h-full items-center gap-0.5 pl-2" role="tablist" aria-label="WorkGraph panel">
                    <PanelTab active={panel().mode() === "attention"} onClick={() => openPanelTab("attention")}>
                      Needs you
                      <Show when={hasAttention()}>
                        <span class="workgraph-attention-dot" aria-hidden="true" />
                      </Show>
                    </PanelTab>
                    <PanelTab active={panel().mode() === "settings"} onClick={() => openPanelTab("settings")}>
                      Settings
                    </PanelTab>
                  </div>
                </Portal>
              )}
            </Show>
            <Show when={panel().bodySlot()}>
              {(slot) => (
                <Portal mount={slot()}>
                  <Switch>
                    <Match when={panel().mode() === "attention"}>
                      <WaitingPanelBody
                        items={attentionItems()}
                        total={attentionTotal()}
                        hasMore={!!attentionNextCursor()}
                        loading={attentionLoading()}
                        loadingMore={attentionLoading() && attentionLoaded()}
                        loaded={attentionLoaded()}
                        error={attentionError()}
                        retry={() => void loadAttention()}
                        onLoadMore={() => void loadAttention(attentionNextCursor())}
                        onSelect={selectWaiting}
                      />
                    </Match>
                    <Match when={panel().mode() === "settings"}>
                      <WorkGraphSettingsView active={panel().mode() === "settings"} source={workgraphSettingsSource} onClose={() => panel().close()} />
                    </Match>
                  </Switch>
                </Portal>
              )}
            </Show>
          </>
        )}
      </Show>
      <WaitingItemDialog selection={selectedWaiting()} source={source} onClose={() => setSelectedWaiting(undefined)} onResolved={resolvedWaiting} onOpenSettings={() => props.panel?.open("settings")} />
      <StreamSettingsDialog open={!!streamSettings()} onClose={() => setStreamSettings(undefined)} stream={streamSettings()} source={streamSettingsSource} />
    </main>
  )
}

function PanelTab(props: { active: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      class="flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors"
      classList={{
        "bg-surface-base text-text-strong": props.active,
        "text-text-weak hover:bg-surface-base-hover hover:text-text-base": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function StatStrip(props: { stats: Array<{ label: string; value: number | string }> }) {
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

function ChipMenu<T extends string>(props: { value: string; selected: T; options: Array<{ value: T; label: string }>; onSelect: (value: T) => void }) {
  const [open, setOpen] = createSignal(false)
  return (
    <Popover placement="bottom-start" portal open={open()} onOpenChange={setOpen} style={{ "z-index": "400" }} trigger={<span class="workgraph-defchip-value">{props.value}</span>} triggerAs="button" triggerProps={{ type: "button", class: "workgraph-defchip" }}>
      <div class="workgraph-chip-menu">
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              class="workgraph-chip-option"
              classList={{ "is-selected": option.value === props.selected }}
              onClick={() => {
                props.onSelect(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              <Show when={option.value === props.selected}>
                <Icon name="check-small" size="small" />
              </Show>
            </button>
          )}
        </For>
      </div>
    </Popover>
  )
}

function LoadingState() {
  return (
    <div class="space-y-3" aria-live="polite" aria-label="Loading WorkGraph">
      <For each={[1, 2, 3]}>{() => <div class="h-12 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />}</For>
    </div>
  )
}

function EmptyState(props: { title: string; copy: string }) {
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

function StatusBanner(props: { error: WorkGraphApiError; retry: () => void; retryLabel?: string }) {
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

function normalizeError(error: unknown) {
  return error instanceof WorkGraphApiError ? error : new WorkGraphApiError("request_failed", error instanceof Error ? error.message : String(error))
}

function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
