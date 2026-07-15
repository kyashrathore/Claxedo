import type { AttentionCursor, AttentionItem, AttemptDto, CommandResult, ExecutionEnvironment, OutcomeDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Dialog as DialogRoot } from "@kobalte/core/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Dialog as DialogShell } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { RichTextEditor } from "@/ui/rich-text"
import { createEffect, createMemo, createResource, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { createWorkGraphClient, WorkGraphApiError, type WorkGraphClient, type WorkGraphSessionOpener } from "./api"
import { ProjectPicker, type LocalProjectOption } from "./project-picker"
import { useWorkGraphSyncLifecycle } from "./sync-lifecycle"
import { environmentChoices } from "./waiting/settings-capabilities"
import { WaitingCard, createWaitingCardController } from "./waiting/waiting-card"
import { TaskDialog, WaitingItemDialog } from "./waiting/item-dialogs"
import { WaitingPanelBody } from "./waiting/waiting-panel"
import { WorkGraphSettingsPanel } from "./settings-panel"
import { toWaitingRow, waitingSourceFromClient } from "./waiting/waiting-source"
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
  /** Whether the shared main panel is currently open in any mode. */
  isOpen: () => boolean
  /** Stable identity for the current open-panel state. */
  identity: () => unknown
  open: (view: "attention" | "settings") => void
  close: () => void
  headerSlot: Accessor<HTMLElement | null>
  bodySlot: Accessor<HTMLElement | null>
}

export function WorkGraphContent(props: {
  active?: Accessor<boolean>
  request?: typeof fetch
  client?: WorkGraphClient
  panel?: WorkGraphPanelBridge
  onOpenSession?: WorkGraphSessionOpener
  executionContext?: ExecutionEnvironment
  localProjects?: readonly LocalProjectOption[]
  onChooseLocalProject?: () => Promise<string | undefined>
}) {
  const client = props.client ?? createWorkGraphClient({ request: props.request })
  const source = waitingSourceFromClient(client)
  const [creating, setCreating] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [reconnecting, setReconnecting] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [environment, setEnvironment] = createSignal<"local_worktree" | "hosted_workspace">(
    props.executionContext?.kind ?? "local_worktree",
  )
  const [localDirectory, setLocalDirectory] = createSignal(
    props.executionContext?.kind === "local_worktree" ? props.executionContext.directory ?? "" : "",
  )
  const [repositoryUrl, setRepositoryUrl] = createSignal(
    props.executionContext?.kind === "hosted_workspace" ? props.executionContext.repositoryUrl ?? "" : "",
  )
  const [baseRevision, setBaseRevision] = createSignal("HEAD")
  const [mutationError, setMutationError] = createSignal<WorkGraphApiError>()

  const [selectedWaiting, setSelectedWaiting] = createSignal<{ item: AttentionItem; invoker: HTMLElement }>()
  const [selectedTask, setSelectedTask] = createSignal<{ item: WorkItemDto; invoker: HTMLElement }>()
  const [streamSettings, setStreamSettings] = createSignal<StreamDto>()
  // Stable references for the focus-restoration fallback hierarchy. Row focus is
  // always scoped to the Needs you panel — never a global text query.
  let needsYouTabRef: HTMLButtonElement | undefined
  let attentionControlRef: HTMLSpanElement | undefined
  // Resolution bookkeeping: whether the just-closed dialog resolved its item (vs
  // a plain close), the attention ordering captured before the resolve refetch,
  // and that refetch's promise — the restore genuinely awaits it before choosing
  // a target rather than racing the resource update.
  let waitingResolved = false
  let waitingPrevOrder: string[] = []
  let waitingRefetch: Promise<void> | undefined

  const closeCreating = () => {
    setCreating(false)
    setExpanded(false)
    setTitle("")
    setDescription("")
    setEnvironment(props.executionContext?.kind ?? "local_worktree")
    setLocalDirectory(props.executionContext?.kind === "local_worktree" ? props.executionContext.directory ?? "" : "")
    setRepositoryUrl(props.executionContext?.kind === "hosted_workspace" ? props.executionContext.repositoryUrl ?? "" : "")
    setBaseRevision("HEAD")
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

  // The execution capability catalog powers the Settings, Stream-settings, and New
  // stream forms — every override option those surfaces offer is projected from it.
  // It is fetched ONLY while one of those surfaces is showing (never for the stream
  // tree) and its explicit failure (the strict 503 capability envelope) is preserved
  // as the resource error, so the forms stay fail-closed on the exact WorkGraphApiError
  // instead of substituting cached or invented choices. Closing and reopening any
  // surface refetches; retry re-runs it in place.
  const capabilitiesNeeded = () => (!!props.panel?.isOpen() && props.panel?.mode() === "settings") || !!streamSettings() || creating()
  const [capabilities, { refetch: refetchCapabilities }] = createResource(
    () => (capabilitiesNeeded() ? true : undefined),
    () => client.executionCapabilities(),
  )
  // An explicit capability failure (its WorkGraphApiError) is observed here and
  // resolves to "no catalog" — the forms then stay fail-closed on that absence
  // rather than substituting cached or hardcoded choices. Reading `.error` first
  // keeps the failure a handled state and never falls through to a stale value.
  const capabilityCatalog = createMemo(() => (capabilities.error ? undefined : capabilities()))
  // The exact resource error, normalized to a WorkGraphApiError, is handed to both
  // settings forms so their footers render its real message and fail closed — never
  // reduced to a generic "no catalog" nor paired with a stale catalog.
  const capabilityResourceError = createMemo(() => (capabilities.error ? normalizeError(capabilities.error) : undefined))

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
  let activeAttentionLoad: Promise<void> | undefined
  const loadAttention = (after?: AttentionCursor) => {
    if (activeAttentionLoad) return activeAttentionLoad
    const request = (async () => {
      setAttentionLoading(true)
      if (!after) setAttentionError(undefined)
      try {
        const page = await source.waiting(after)
        setAttentionItems((prev) => (after ? [...prev, ...page.items] : page.items))
        setAttentionTotal(page.total)
        setAttentionNextCursor(page.hasMore ? page.nextCursor : undefined)
        setAttentionLoaded(true)
        setAttentionError(undefined)
      } catch (error) {
        setAttentionError(error)
      } finally {
        setAttentionLoading(false)
        activeAttentionLoad = undefined
      }
    })()
    activeAttentionLoad = request
    return request
  }
  onMount(() => void loadAttention())

  const records = createMemo(() => snapshot()?.records ?? [])
  const streams = createMemo(() => records().filter((record): record is StreamDto => record.recordType === "stream"))
  const attempts = createMemo(() => records().filter((record): record is AttemptDto => record.recordType === "attempt"))
  const workItems = createMemo(() => records().filter((record): record is WorkItemDto => record.recordType === "work_item"))
  const selectedTaskItem = createMemo(() => selectedTask() && (
    workItems().find((item) => item.id === selectedTask()!.item.id) ?? selectedTask()!.item
  ))
  const selectedTaskGranularity = createMemo(() => streams().find((stream) => stream.id === selectedTaskItem()?.streamId)?.activityGranularity)
  const outcomes = createMemo(() => records().filter((record): record is OutcomeDto => record.recordType === "outcome"))
  const activeAttempts = createMemo(() => attempts().filter((attempt) => ["admitted", "placing", "running"].includes(attempt.state)))
  const sortedStreams = createMemo(() => [...streams()].sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt))

  const hasAttention = () => attentionTotal() > 0
  const card = createWaitingCardController(attentionItems)
  const contextMode = () => card.mode(props.panel?.isOpen() ?? false, props.panel?.identity())

  const retryMutation = () => {
    void refetch()
  }
  // One live synchronizer, seeded once from the first canonical snapshot cursor
  // and never restarted by later snapshot updates (it reloads the snapshot
  // itself). It drives the bounded /changes long-poll continuously; its stall is
  // surfaced verbatim through the sync StatusBanner, whose Retry resumes the loop
  // from the last good cursor. cursor_invalid is auto-reset inside the loop, so it
  // never reaches the banner.
  // Applying a change window (and resetting after cursor_invalid) reloads the
  // canonical snapshot and Attention together; the fresh snapshot cursor is
  // returned so the loop can resume from it after a reset.
  const reloadCanonical = async () => {
    await Promise.all([refetch(), loadAttention()])
    return snapshot()?.snapshotCursor
  }
  const acknowledgeAttention = async (action: () => Promise<unknown>) => {
    setAttentionError(undefined)
    try {
      await action()
      await activeAttentionLoad
      await loadAttention()
    } catch (error) {
      setAttentionError(error)
    }
  }
  const sync = useWorkGraphSyncLifecycle({
    active: () => props.active?.() ?? true,
    snapshot,
    changes: client.changes,
    reload: reloadCanonical,
  })
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
  const createStream = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!title().trim()) return
    const summary = description().trim()
    const selectedEnvironment = environment()
    const execution: NonNullable<Parameters<typeof client.createStream>[0]["execution"]> = {
      environment: selectedEnvironment === "local_worktree"
        ? { kind: "local_worktree", directory: localDirectory().trim() }
        : { kind: "hosted_workspace", repositoryUrl: repositoryUrl().trim() },
      repository: { baseRevision: baseRevision().trim() },
    }
    if (!(await mutate(() => client.createStream({
      title: title().trim(),
      ...(summary ? { description: summary } : {}),
      execution,
    })))) return
    closeCreating()
  }
  const createEnvironmentValues = () => {
    const catalog = capabilityCatalog()
    return catalog ? environmentChoices(catalog) : []
  }
  const openCreating = () => {
    setBaseRevision(capabilityCatalog()?.repository.baseRevisions[0] ?? "HEAD")
    if (!props.executionContext) {
      const choices = createEnvironmentValues()
      const next = choices[0]
      if (next) setEnvironment(next)
    }
    setCreating(true)
  }
  const createOverrideInvalid = () => {
    const env = environment()
    const catalog = capabilityCatalog()
    if (!catalog) return true
    if (!environmentChoices(catalog).some((kind) => kind === env)) return true
    if (!baseRevision().trim()) return true
    if (env === "local_worktree" && !localDirectory().trim()) return true
    if (env === "hosted_workspace") {
      try {
        new URL(repositoryUrl().trim())
      } catch {
        return true
      }
    }
    return false
  }
  const reconnect = async () => {
    setReconnecting(true)
    await refetch()
    setReconnecting(false)
  }

  const openPanelTab = (view: "attention" | "settings") => {
    card.closeFloating()
    props.panel?.open(view)
  }
  const openWaitingItemInPanel = (item: AttentionItem) => {
    openPanelTab("attention")
    void nextFrame().then(async () => {
      if (focusRowByKey(toWaitingRow(item).key)) return
      await nextFrame()
      focusRowByKey(toWaitingRow(item).key)
    })
  }
  const showAttentionContext = () => {
    if (!hasAttention()) return openPanelTab("attention")
    if (contextMode()) return card.dismiss()
    card.reveal(props.panel?.isOpen() ?? false, props.panel?.identity())
  }
  const openWorkGraphSettings = () => {
    setStreamSettings(undefined)
    openPanelTab("settings")
  }
  const openStreamSettings = (stream: StreamDto) => {
    setStreamSettings(stream)
    openPanelTab("settings")
  }
  // A selection records the exact invoking element so an ordinary close returns
  // focus to the row that opened the dialog.
  const selectWaiting = (item: AttentionItem, element: HTMLElement) => {
    waitingResolved = false
    waitingRefetch = undefined
    setSelectedWaiting({ item, invoker: element })
  }
  const selectTask = (item: WorkItemDto, invoker: HTMLElement) => setSelectedTask({ item, invoker })
  const closeTask = () => {
    const invoker = selectedTask()?.invoker
    if (!invoker) return
    setSelectedTask(undefined)
    queueMicrotask(() => focusElement(invoker))
  }
  const resolvedTask = () => void refetch()
  // A real domain transition: remember the pre-refetch ordering and start the
  // attention refetch, but defer the focus move to close (see closeWaiting) so it
  // lands after the dialog has actually torn down.
  const resolvedWaiting = () => {
    waitingResolved = true
    waitingPrevOrder = attentionItems().map((item) => toWaitingRow(item).key)
    waitingRefetch = loadAttention()
  }
  // Single close funnel (Kobalte close, Escape, and content-initiated close all
  // route here). Idempotent: the first pass clears the selection and moves focus,
  // the echo pass sees no selection and returns.
  const closeWaiting = () => {
    const selection = selectedWaiting()
    if (!selection) return
    setSelectedWaiting(undefined)
    const resolved = waitingResolved
    waitingResolved = false
    if (resolved) void restoreFocusAfterResolve(selection)
    else focusElement(selection.invoker)
  }
  const focusElement = (element: HTMLElement | undefined | null) => {
    if (element?.isConnected) element.focus()
  }
  const panelRows = (): HTMLElement[] => {
    const list = props.panel?.bodySlot()?.querySelector(".workgraph-waiting-list")
    return list ? [...list.querySelectorAll<HTMLElement>(".workgraph-waiting-row")] : []
  }
  // Focuses the currently-rendered panel row for a stable attention key by
  // pairing live items with rows positionally. Returns whether it landed.
  const focusRowByKey = (key: string) => {
    const index = card.items().findIndex((item) => toWaitingRow(item).key === key)
    if (index < 0) return false
    const row = panelRows()[index]
    if (!row?.isConnected) return false
    row.focus()
    return true
  }
  const focusFallback = () => {
    if (needsYouTabRef?.isConnected) return focusElement(needsYouTabRef)
    focusElement(attentionControlRef?.querySelector<HTMLElement>("button"))
    // Anything further defers to the dialog's own focus restoration.
  }
  const restoreFocusAfterResolve = async (selection: { item: AttentionItem; invoker: HTMLElement }) => {
    // 1) Genuinely await the attention refetch so the surface has re-rendered its
    //    rows for the post-action ordering before any target is chosen.
    await (waitingRefetch ?? Promise.resolve())
    waitingRefetch = undefined
    // 2) Await the closing dialog's teardown. Its modal focus scope performs one
    //    deferred focus-restoration on the next animation frame (re-asserting focus
    //    into its still-present content while the exit transition runs). Letting
    //    that one-shot land first makes our restoration the last word — otherwise it
    //    clobbers a focus we set on the earlier microtask.
    await nextFrame()
    const removedKey = toWaitingRow(selection.item).key
    const items = attentionItems()
    const liveKeys = new Set(items.map((item) => toWaitingRow(item).key))
    if (liveKeys.has(removedKey)) {
      // The item survived the action: prefer its exact invoker, else its
      // re-rendered row, else the surface fallback.
      if (selection.invoker.isConnected) return focusElement(selection.invoker)
      if (focusRowByKey(removedKey)) return
      return focusFallback()
    }
    // The item left Waiting: focus the next still-present row in the previous
    // ordering, then the previous one, then the fallback hierarchy.
    const removedIndex = waitingPrevOrder.indexOf(removedKey)
    let targetKey: string | undefined
    for (let i = removedIndex + 1; i < waitingPrevOrder.length && targetKey === undefined; i++) {
      if (liveKeys.has(waitingPrevOrder[i])) targetKey = waitingPrevOrder[i]
    }
    for (let i = removedIndex - 1; i >= 0 && targetKey === undefined; i--) {
      if (liveKeys.has(waitingPrevOrder[i])) targetKey = waitingPrevOrder[i]
    }
    if (targetKey !== undefined && focusRowByKey(targetKey)) return
    focusFallback()
  }

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
  const waitingCard = (mode: "inline" | "floating") => <WaitingCard mode={mode} items={card.items()} total={attentionTotal()} unread={card.unread()} onClose={card.closeFloating} onSelect={openWaitingItemInPanel} />

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
                  <span class="workgraph-attention-control" ref={attentionControlRef}>
                    <IconButton
                      variant="ghost"
                      size="small"
                      icon="bullet-list"
                      aria-label={hasAttention() ? `Needs you — ${attentionTotal()} waiting on you` : "Needs you"}
                      aria-pressed={contextMode() !== undefined}
                      class="aria-pressed:bg-surface-base-hover aria-pressed:text-text-base"
                      onClick={showAttentionContext}
                    />
                  </span>
                  <IconButton variant="ghost" size="small" icon="sliders" aria-label="WorkGraph settings" onClick={openWorkGraphSettings} />
                </div>
                <Button size="small" icon="plus-small" variant="primary" onClick={openCreating} aria-haspopup="dialog">
                  New stream
                </Button>
              </div>
            </div>
            <p class="workgraph-lede text-text-weak">Every thread of work you're shipping with AI. Expand a stream to see its outcomes and the tasks underneath.</p>
          </header>
          <div class="workgraph-body" classList={{ "has-context": contextMode() === "inline" }}>
            <div class="workgraph-primary">
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
                        value={environment() === "local_worktree" ? "Local worktree" : "Cloud workspace"}
                        selected={environment()}
                        options={createEnvironmentValues().map((kind) => ({
                          value: kind,
                          label: kind === "local_worktree" ? "Local worktree" : "Cloud workspace",
                        }))}
                        onSelect={setEnvironment}
                      />
                    </div>
                    <Show
                      when={environment() === "local_worktree"}
                      fallback={
                        <label class="workgraph-create-target">
                          <span>GitHub repository URL</span>
                          <input
                            value={repositoryUrl()}
                            onInput={(event) => setRepositoryUrl(event.currentTarget.value)}
                            placeholder="https://github.com/owner/repository.git"
                            required
                          />
                          <small>The cloud workspace clones this repository for every Stream Attempt.</small>
                        </label>
                      }
                    >
                      <div class="workgraph-create-target">
                        <span>Project directory</span>
                        <ProjectPicker
                          value={localDirectory()}
                          projects={props.localProjects ?? []}
                          onChange={setLocalDirectory}
                          onChoose={props.onChooseLocalProject}
                          onError={(error) => setMutationError(normalizeError(error))}
                        />
                        <small>The Stream creates its isolated worktree from this local Git repository.</small>
                      </div>
                    </Show>
                    <label class="workgraph-create-target">
                      <span>Base revision</span>
                      <input
                        value={baseRevision()}
                        onInput={(event) => setBaseRevision(event.currentTarget.value)}
                        list="workgraph-stream-base-revisions"
                        placeholder="HEAD"
                        required
                      />
                      <datalist id="workgraph-stream-base-revisions">
                        <For each={capabilityCatalog()?.repository.baseRevisions ?? []}>
                          {(revision) => <option value={revision} />}
                        </For>
                      </datalist>
                      <small>The Git ref used to create this Stream's execution workspace.</small>
                    </label>
                    <Show when={mutationError()}>{(error) => <StatusBanner error={error()} retry={retryMutation} />}</Show>
                    <Show when={capabilityResourceError()}>{(error) => <StatusBanner error={error()} retry={() => void refetchCapabilities()} />}</Show>
                    <div class="workgraph-create-actions">
                      <span class="workgraph-create-hint text-text-weaker">
                        <kbd>⌘</kbd> <kbd>↵</kbd> to create
                      </span>
                      <div class="flex gap-2">
                        <Button type="button" size="small" variant="ghost" onClick={closeCreating}>
                          Cancel
                        </Button>
                        <Button type="submit" size="small" variant="primary" disabled={!title().trim() || submitting() || createOverrideInvalid()}>
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
          <Show when={sync.error()}>{(error) => <div class="workgraph-toast"><StatusBanner error={error()} retry={sync.retry} /></div>}</Show>
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
                  onOpenStreamSettings={openStreamSettings}
                  onOpenTask={selectTask}
                  onOpenSession={props.onOpenSession}
                />
              </div>
            </Match>
          </Switch>
            </div>
            <Show when={contextMode() === "inline"}>{waitingCard("inline")}</Show>
          </div>
        </div>
      </div>
      <Show when={contextMode() === "floating"}>{waitingCard("floating")}</Show>
      {/* The two WorkGraph tabs + the active view live in the one shared panel. */}
      <Show when={props.panel}>
        {(panel) => (
          <>
            <Show when={panel().headerSlot()}>
              {(slot) => (
                <Portal mount={slot()}>
                  <div class="flex h-full items-center gap-0.5 pl-2" role="tablist" aria-label="WorkGraph panel">
                    <PanelTab ref={(element) => (needsYouTabRef = element)} active={panel().mode() === "attention"} onClick={() => openPanelTab("attention")}>
                      Needs you
                      <Show when={card.unread() > 0}>
                        <span class="workgraph-attention-dot" aria-hidden="true" />
                      </Show>
                    </PanelTab>
                    <PanelTab active={panel().mode() === "settings"} onClick={openWorkGraphSettings}>
                      Settings
                    </PanelTab>
                  </div>
                </Portal>
              )}
            </Show>
            <Show when={panel().bodySlot()}>
              {(slot) => (
                <Portal mount={slot()} ref={(element) => element.classList.add("workgraph-panel-body-portal")}>
                  <Switch>
                    <Match when={panel().mode() === "attention"}>
                      <WaitingPanelBody
                        items={card.items()}
                        total={attentionTotal()}
                        hasMore={!!attentionNextCursor()}
                        loading={attentionLoading()}
                        loadingMore={attentionLoading() && attentionLoaded()}
                        loaded={attentionLoaded()}
                        error={attentionError()}
                        retry={() => void loadAttention()}
                        unread={card.unread()}
                        onMarkAllRead={() => void acknowledgeAttention(source.markAllRead)}
                        onClear={() => void acknowledgeAttention(source.clear)}
                        onLoadMore={() => void loadAttention(attentionNextCursor())}
                        onSelect={selectWaiting}
                      />
                    </Match>
                    <Match when={panel().mode() === "settings"}>
                      <WorkGraphSettingsPanel active workgraphSource={workgraphSettingsSource} streamSource={streamSettingsSource} stream={streamSettings()} capabilities={capabilityCatalog()} capabilitiesError={capabilityResourceError()} capabilitiesLoading={capabilities.loading} localProjects={props.localProjects} onChooseLocalProject={props.onChooseLocalProject} onClose={() => {
                        setStreamSettings(undefined)
                        panel().close()
                      }} />
                    </Match>
                  </Switch>
                </Portal>
              )}
            </Show>
          </>
        )}
      </Show>
      <WaitingItemDialog selection={selectedWaiting()?.item} source={source} onClose={closeWaiting} onResolved={resolvedWaiting} onOpenSettings={openWorkGraphSettings} onOpenSession={props.onOpenSession} />
      <TaskDialog item={selectedTaskItem()} refreshToken={snapshot()?.snapshotCursor} activityGranularity={selectedTaskGranularity()} source={source} onClose={closeTask} onResolved={resolvedTask} onOpenSession={props.onOpenSession} />
    </main>
  )
}

function PanelTab(props: { active: boolean; onClick: () => void; children: JSX.Element; ref?: (element: HTMLButtonElement) => void }) {
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

// Resolves after the next animation frame — the point by which a closing modal
// dialog has performed its one deferred focus-restoration. Registered after the
// dialog's own frame, so focus work chained on this runs strictly afterwards.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
