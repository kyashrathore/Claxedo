import type { OutcomeDto, RunDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { NewSessionDesignView } from "@/features/session/ui/components/session-new-design-view"
import { MAIN_WORKTREE, type NewSessionWorkspaceKind } from "@/features/session/ui/components/session-new-workspace-options"
import { createWorkGraphClient } from "@/features/workgraph/api"
import { appProjectWorkGraphKey } from "@/features/workgraph/project-key"
import { StreamCard, streamProject } from "@/features/workgraph/workgraph-overview"
import { useWorkGraphSyncLifecycle } from "@/features/workgraph/sync-lifecycle"
import { PanelTab } from "@/features/workgraph/content-chrome"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"

type ProjectShape = {
  worktree: string
  name?: string
  git?: { remote?: string | null }
  workspaces?: Record<
    string,
    {
      id?: string
      workspaceId?: string
      directory?: string
      remote_directory?: string
      kind?: string
      git_remote?: string
      repo_url?: string
    }
  >
}
type WorkspaceDirectoryRef = string

export function TaskComposerView(props: { directory?: string; request?: typeof fetch; onRetarget?: (directory: WorkspaceDirectoryRef) => void }) {
  const queryOptions = useShellQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const client = createWorkGraphClient({ request: props.request })
  // Both resources below swallow their rejection into `undefined` rather than
  // letting it reach the reader. A thrown resource has no ErrorBoundary between
  // here and the app root, so an unreachable or empty WorkGraph ledger — the
  // fresh-profile case — blanked the whole renderer the moment the top-level
  // "New task" button mounted this view. The composer already renders an empty
  // Stream list and a disabled submit for the no-data case; a failed load is
  // surfaced there, not as a crash.
  const [loadError, setLoadError] = createSignal<string>()
  const [snapshot, { refetch }] = createResource(async () => {
    try {
      const value = await client.snapshot()
      setLoadError()
      return value
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "WorkGraph is unavailable.")
      return undefined
    }
  })
  const [tab, setTab] = createSignal<"compose" | "streams">("compose")
  const [directory, setDirectory] = createSignal(props.directory ?? "")
  const [capabilities] = createResource(
    () => directory(),
    async (value) => {
      try {
        return await client.executionCapabilities({ directory: value })
      } catch {
        return undefined
      }
    },
  )
  const [streamId, setStreamId] = createSignal("")
  const [intent, setIntent] = createSignal("")
  const [profile, setProfile] = createSignal("")
  const [fallbackHarness, setFallbackHarness] = createSignal("")
  const [fallbackModel, setFallbackModel] = createSignal("")
  const [draft, setDraft] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [message, setMessage] = createSignal<{ kind: "error" | "success"; text: string }>()

  const projects = createMemo(() => (projectsQuery.data ?? []) as ProjectShape[])
  const selectedProject = createMemo(
    () =>
      projects().find(
        (project) =>
          project.worktree === directory() ||
          Object.entries(project.workspaces ?? {}).some(([key, workspace]) =>
            [key, workspace.id, workspace.workspaceId, workspace.directory, workspace.remote_directory].includes(directory()),
          ),
      ) ?? projects()[0],
  )
  const projectKey = createMemo(() => (selectedProject() ? appProjectWorkGraphKey(selectedProject()!, directory()) : undefined))
  const streams = createMemo(() =>
    (snapshot()?.records ?? [])
      .filter((record): record is StreamDto => record.recordType === "stream")
      .filter((stream) => !projectKey() || streamProject(stream).key === projectKey()),
  )
  const records = createMemo(() => snapshot()?.records ?? [])
  const outcomes = createMemo(() => records().filter((record): record is OutcomeDto => record.recordType === "outcome"))
  const items = createMemo(() => records().filter((record): record is WorkItemDto => record.recordType === "work_item"))
  const runs = createMemo(() => records().filter((record): record is RunDto => record.recordType === "run"))
  const selectedStream = createMemo(() => streams().find((stream) => stream.id === streamId()) ?? (streams().length === 1 ? streams()[0] : undefined))
  const agents = createMemo(() => selectedStream()?.executionDefaults.agents ?? [])
  const placement = createMemo(() => selectedStream()?.executionDefaults.environment?.placement ?? "shared")
  const selectedHarness = createMemo(() => fallbackHarness() || selectedStream()?.executionDefaults.harness || capabilities()?.harnesses[0]?.id || "")
  const models = createMemo(() => (capabilities()?.models ?? []).filter((model) => model.harnessId === selectedHarness()))
  const selectedModel = createMemo(() => {
    const configured = selectedStream()?.executionDefaults.model
    const requested = fallbackModel()
    if (requested && models().some((model) => `${model.providerId}/${model.modelId}` === requested)) return requested
    if (configured && configured.providerId && configured.modelId) return `${configured.providerId}/${configured.modelId}`
    const first = models()[0]
    return first ? `${first.providerId}/${first.modelId}` : ""
  })
  useWorkGraphSyncLifecycle({
    active: () => true,
    reload: async () => await refetch(),
    snapshotCursor: () => snapshot()?.snapshotCursor,
  })

  const retarget = (next: string) => {
    setDirectory(next)
    setStreamId("")
    setProfile("")
    props.onRetarget?.(next)
  }
  const selectStream = (stream: StreamDto) => {
    setStreamId(stream.id)
    setProfile("")
    setTab("compose")
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const stream = selectedStream()
    const text = intent().trim()
    if (!stream || !text || submitting()) return
    setSubmitting(true)
    setMessage()
    const title = text.split("\n", 1)[0]!.slice(0, 160)
    try {
      const result = await client.createWorkItem({
        streamId: stream.id,
        title,
        ...(text === title ? {} : { description: text }),
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [
            {
              id: `requirement-${crypto.randomUUID()}`,
              kind: "owner_confirmation",
              description: `Confirm ${title} is complete`,
            },
          ],
        },
        ...(profile()
          ? { execution: { assignments: { execution: profile() } } }
          : agents().length === 0 && selectedHarness() && selectedModel()
            ? {
                execution: {
                  harness: selectedHarness(),
                  model: {
                    providerId: selectedModel().split("/", 1)[0]!,
                    modelId: selectedModel().slice(selectedModel().indexOf("/") + 1),
                  },
                },
              }
            : {}),
        ...(draft() ? { draft: true } : {}),
      })
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error.message })
        return
      }
      setIntent("")
      setMessage({ kind: "success", text: draft() ? "Draft task saved." : "Task added to the Stream." })
      await refetch()
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Task creation failed." })
    } finally {
      setSubmitting(false)
    }
  }

  const selectedDirectory = () => selectedProject()?.worktree ?? directory()
  return (
    <NewSessionDesignView
      worktree={selectedDirectory()}
      workspaceKind={"local" satisfies NewSessionWorkspaceKind}
      onWorktreeChange={(value) => {
        if (value !== MAIN_WORKTREE) retarget(value)
      }}
      onWorkspaceKindChange={() => undefined}
      onProjectChange={retarget}
    >
      <section class="overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base shadow-sm">
        <header class="flex items-center justify-between gap-3 border-b border-border-weaker-base px-3.5 py-2.5">
          <div class="flex items-center gap-2">
            <Icon name="checklist" size="small" class="text-icon-weak-base" />
            <span class="text-[12px] font-medium text-text-base">New task</span>
          </div>
          <div role="tablist" aria-label="Task composer" class="flex items-center gap-0.5">
            <PanelTab active={tab() === "compose"} onClick={() => setTab("compose")}>
              Compose
            </PanelTab>
            <PanelTab active={tab() === "streams"} onClick={() => setTab("streams")}>
              Streams
            </PanelTab>
          </div>
        </header>
        <Show when={loadError()}>
          {(text) => (
            <p role="status" class="border-b border-border-weaker-base bg-surface-base px-3.5 py-2 text-[11px] text-icon-critical-base">
              WorkGraph could not be loaded — {text()}
            </p>
          )}
        </Show>
        <Show when={projectKey()?.startsWith("hosted:")}>
          <p class="border-b border-border-weaker-base bg-surface-base px-3.5 py-2 text-[11px] text-text-weak">
            Hosted project · tasks run in its connected cloud workspace.
          </p>
        </Show>

        <Show
          when={tab() === "compose"}
          fallback={
            <div class="max-h-[360px] overflow-y-auto p-3" role="tabpanel" aria-label="Streams">
              <Show when={streams().length} fallback={<p class="px-2 py-8 text-center text-[12px] text-text-weaker">No Streams belong to this project yet.</p>}>
                <div class="space-y-1">
                  <For each={streams()}>
                    {(stream) => (
                      <StreamCard
                        stream={stream}
                        parentStream={streams().find((candidate) => candidate.id === stream.parentStreamId)}
                        outcomes={outcomes().filter((outcome) => outcome.streamId === stream.id)}
                        items={items().filter((item) => item.streamId === stream.id)}
                        runs={runs().filter((run) => run.streamId === stream.id)}
                        relativeTime={(timestamp) => new Date(timestamp).toLocaleString()}
                        client={client}
                        mutate={async (action) => {
                          const result = await action()
                          if (!result.ok) {
                            setMessage({ kind: "error", text: result.error.message })
                            return false
                          }
                          await refetch()
                          return true
                        }}
                        onOpenStreamSettings={selectStream}
                        onOpenStreamNotes={selectStream}
                        onOpenStreamTasks={selectStream}
                        onSelectStream={selectStream}
                        onOpenTask={() => undefined}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
          }
        >
          <form class="p-3" onSubmit={submit} role="tabpanel" aria-label="Compose">
            <label class="block">
              <span class="sr-only">Task intent</span>
              <textarea
                autofocus
                value={intent()}
                onInput={(event) => setIntent(event.currentTarget.value)}
                placeholder="Describe the task and what done looks like…"
                class="min-h-32 w-full resize-none rounded-lg border border-border-base bg-surface-base px-3.5 py-3 text-[13px] leading-5 text-text-base outline-none transition-colors placeholder:text-text-weaker focus:border-border-interactive-base focus:ring-1 focus:ring-border-interactive-focus"
              />
            </label>
            <div class="mt-2.5 flex flex-wrap items-center gap-2">
              <label class="min-w-44 flex-1">
                <span class="sr-only">Target Stream</span>
                <select
                  aria-label="Target Stream"
                  value={selectedStream()?.id ?? ""}
                  onChange={(event) => {
                    setStreamId(event.currentTarget.value)
                    setProfile("")
                  }}
                  class="h-8 w-full rounded-md border border-border-base bg-surface-base px-2.5 text-[12px] text-text-base outline-none focus:border-border-interactive-base"
                >
                  <option value="" disabled>
                    Select a Stream
                  </option>
                  <For each={streams()}>{(stream) => <option value={stream.id}>{stream.title}</option>}</For>
                </select>
              </label>
              <label class="min-w-36 flex-1">
                <span class="sr-only">Agent profile</span>
                <select
                  aria-label="Agent profile"
                  value={profile()}
                  onChange={(event) => setProfile(event.currentTarget.value)}
                  class="h-8 w-full rounded-md border border-border-base bg-surface-base px-2.5 text-[12px] text-text-base outline-none focus:border-border-interactive-base"
                >
                  <option value="">Default</option>
                  <For each={agents()}>
                    {(agent) => (
                      <option value={agent.name}>
                        {agent.name} — {agent.brief}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <span
                class="inline-flex h-8 items-center rounded-md border border-border-base bg-surface-base px-2.5 text-[12px] capitalize text-text-weak"
                title="Placement is owned by the target Stream"
              >
                {placement()}
              </span>
            </div>
            <Show when={selectedStream() && agents().length === 0}>
              <details class="mt-2 rounded-md border border-border-weaker-base bg-surface-base px-2.5 py-2 text-[11px] text-text-weaker">
                <summary class="cursor-pointer select-none text-text-weak">Execution settings</summary>
                <div class="mt-2 grid gap-2 sm:grid-cols-2">
                  <label>
                    <span class="mb-1 block">Harness</span>
                    <select
                      aria-label="Execution harness"
                      value={selectedHarness()}
                      onChange={(event) => {
                        setFallbackHarness(event.currentTarget.value)
                        setFallbackModel("")
                      }}
                      class="h-8 w-full rounded-md border border-border-base bg-surface-raised-base px-2 text-[12px] text-text-base"
                    >
                      <For each={capabilities()?.harnesses ?? []}>{(harness) => <option value={harness.id}>{harness.id}</option>}</For>
                    </select>
                  </label>
                  <label>
                    <span class="mb-1 block">Model</span>
                    <select
                      aria-label="Execution model"
                      value={selectedModel()}
                      onChange={(event) => setFallbackModel(event.currentTarget.value)}
                      class="h-8 w-full rounded-md border border-border-base bg-surface-raised-base px-2 text-[12px] text-text-base"
                    >
                      <For each={models()}>{(model) => <option value={`${model.providerId}/${model.modelId}`}>{model.label}</option>}</For>
                    </select>
                  </label>
                </div>
              </details>
            </Show>
            <div class="mt-3 flex items-center justify-between gap-3">
              <label class="flex cursor-pointer items-center gap-2 text-[12px] text-text-weak">
                <input type="checkbox" checked={draft()} onChange={(event) => setDraft(event.currentTarget.checked)} />
                Save as Draft
              </label>
              <Button type="submit" size="small" variant="primary" disabled={!intent().trim() || !selectedStream() || submitting()}>
                {submitting() ? "Creating…" : draft() ? "Save draft" : "Create task"}
              </Button>
            </div>
            <Show when={message()}>
              {(status) => (
                <p
                  role="status"
                  class="mt-2 text-[11px]"
                  classList={{
                    "text-icon-critical-base": status().kind === "error",
                    "text-text-weak": status().kind === "success",
                  }}
                >
                  {status().text}
                </p>
              )}
            </Show>
          </form>
        </Show>
      </section>
    </NewSessionDesignView>
  )
}
