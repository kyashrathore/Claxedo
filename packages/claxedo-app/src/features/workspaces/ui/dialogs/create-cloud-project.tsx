import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { api, authFetch, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import type { ClaxedoEvent } from "../../../../app/integrations/claxedo-events"
import { useClaxedoEvents } from "@/features/workspaces/app-ports"
import { workspaceCreateUrl, workspaceProvidersUrl, workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { classifyProvisionFailure, readyProvisionDirectory } from "./provision-failure"
import { sandboxProviderFacts } from "./provider-facts"
import { loadConnectedRepositories, type RepositoryChoice } from "./repository-picker"

type DialogCreateCloudProjectProps = {
  onSelect: (result: string | string[] | null) => void
}

interface CreateWorkspaceResult {
  workspaceId: string
  projectId?: string
  directory?: string
  workspaceBaseUrl?: string
  provider?: string
  kind?: string
  status?: string
}

function controlPlaneBaseUrl(baseUrl: string) {
  return normalizeUrl(baseUrl) ?? getDefaultBaseUrl()
}

async function createCloudProject(
  baseUrl: string,
  provider: string,
  name: string,
  source: { repoUrl: string } | { connectionId: string; repo: { fullName: string } },
): Promise<CreateWorkspaceResult> {
  return api.post<CreateWorkspaceResult>(
    workspaceCreateUrl({ baseUrl }),
    {
      provider,
      projectName: name,
      workspaceName: "main",
      ...source,
    },
  )
}

type Provider = {
  id: string
  label: string
  configured: boolean
  default: boolean
}

type ProviderResponse = {
  default_provider: string
  providers: Provider[]
}

type ProvisionLog = {
  step: string
  message?: string
  ts: number
  totalMs?: number
}

type ProvisionEvent = Extract<ClaxedoEvent, { type: "provision" }>
type ProvisionStep = ProvisionEvent["step"]

const PROVISION_PIPELINE = [
  { key: "acquiring_sandbox", label: "Acquiring sandbox" },
  { key: "cloning", label: "Cloning repository" },
  { key: "starting_runtime", label: "Starting runtime" },
  { key: "waiting_health", label: "Waiting for health check" },
]

function isProvisionStep(status: string | null | undefined): status is ProvisionStep {
  return status === "acquiring_sandbox" ||
    status === "cloning" ||
    status === "starting_runtime" ||
    status === "waiting_health" ||
    status === "ready" ||
    status === "error"
}

/**
 * DialogCreateCloudProject component for creating new cloud projects.
 * Allows users to clone a Git repository into a cloud sandbox.
 * Shows live provisioning progress via SSE events.
 */
export function DialogCreateCloudProject(props: DialogCreateCloudProjectProps) {
  const [repoUrl, setRepoUrl] = createSignal("")
  const [repository, setRepository] = createSignal<RepositoryChoice>()
  const [repositorySearch, setRepositorySearch] = createSignal("")
  const [repositories, setRepositories] = createSignal<RepositoryChoice[]>([])
  const [provider, setProvider] = createSignal("")
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [phase, setPhase] = createSignal<"form" | "provisioning">("form")
  const [logs, setLogs] = createSignal<ProvisionLog[]>([])
  const [error, setError] = createSignal("")
  const dialog = useDialog()
  const events = useClaxedoEvents()

  const baseUrl = getDefaultBaseUrl()
  const filteredRepositories = createMemo(() => {
    const search = repositorySearch().trim().toLowerCase()
    if (!search) return repositories()
    return repositories().filter((item) => item.fullName.toLowerCase().includes(search))
  })

  onMount(() => {
    void api
      .get<ProviderResponse>(workspaceProvidersUrl({ baseUrl }))
      .then((data) => {
        setProviders(data.providers)
        setProvider(data.default_provider)
      })
      .catch(() => {
        setProviders([])
        setProvider("")
      })
    void loadConnectedRepositories((path) => authFetch(
      new URL(`/api/claxedo/integrations${path}`, controlPlaneBaseUrl(baseUrl)).toString(),
    )).then(setRepositories).catch(() => setRepositories([]))
  })

  const lastPipelineKey = () => {
    const all = logs()
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].step !== "ready" && all[i].step !== "redirecting" && all[i].step !== "error") {
        return all[i].step
      }
    }
    return null
  }
  const isReady = () => logs().some(l => l.step === "ready")
  const isRedirecting = () => logs().some(l => l.step === "redirecting")
  const failure = () => error() ? classifyProvisionFailure(error()) : undefined
  const pipelineStepState = (key: string, idx: number): "done" | "active" | "pending" | "error" => {
    if (isReady()) return "done"
    const lastKey = lastPipelineKey()
    if (!lastKey) {
      if (idx === 0 && phase() === "provisioning") return "active"
      return "pending"
    }
    const lastIdx = PROVISION_PIPELINE.findIndex(p => p.key === lastKey)
    if (error() && idx === lastIdx) return "error"
    if (idx === lastIdx) return "active"
    if (idx < lastIdx) return "done"
    return "pending"
  }
  const pipelineStepDuration = (key: string) => {
    const all = logs()
    const idx = all.findIndex(l => l.step === key)
    if (idx === -1) return undefined
    const next = all[idx + 1]
    if (!next) return undefined
    return ((next.ts - all[idx].ts) / 1000).toFixed(1)
  }
  const totalElapsed = () => {
    const all = logs()
    const readyStep = all.find(l => l.step === "ready")
    if (!readyStep || all.length < 2) return undefined
    return ((readyStep.ts - all[0].ts) / 1000).toFixed(1)
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    if ((!repoUrl() && !repository()) || !provider()) return

    setPhase("provisioning")
    setLogs([])
    setError("")

    const buffered: ProvisionEvent[] = []
    const seen = new Set<string>()
    let workspaceId: string | undefined
    let unsub: (() => void) | undefined

    const appendProvision = (ev: ProvisionEvent, directory: string) => {
      if (ev.workspaceId !== workspaceId) return

      const key = `${ev.step}:${ev.message ?? ""}`
      if (!seen.has(key)) {
        seen.add(key)
        setLogs((prev) => [...prev, {
          step: ev.step,
          message: ev.message,
          ts: ev.ts,
          totalMs: ev.totalMs,
        }])
      }

      if (ev.step === "ready") {
        const ready = readyProvisionDirectory(ev.step, directory)
        if (!ready) return
        unsub?.()
        setLogs((prev) => [...prev, { step: "redirecting", ts: Date.now() }])
        setTimeout(() => {
          props.onSelect(ready)
          dialog.close()
        }, 1200)
      }

      if (ev.step === "error") {
        unsub?.()
        setError(ev.message || "Provisioning failed")
      }
    }

    unsub = events.on("provision", (ev) => {
      if (!workspaceId) {
        buffered.push(ev)
      }
    })
    onCleanup(unsub)

    try {
      const selected = repository()
      const source = selected
        ? { connectionId: selected.connectionId, repo: { fullName: selected.fullName } }
        : { repoUrl: repoUrl() }
      const name = (selected?.name ?? repoUrl().split("/").pop()?.replace(".git", "")) || "Untitled"
      const created = await createCloudProject(baseUrl, provider(), name, source)

      if (!created.directory) throw new Error("Workspace create did not return a directory")
      workspaceId = created.workspaceId

      unsub?.()
      unsub = events.on("provision", (ev) => appendProvision(ev, created.directory!))
      onCleanup(unsub)
      for (const ev of buffered) appendProvision(ev, created.directory)
      const current = await api
        .get<{ status?: string | null }>(workspaceResolveUrl({ baseUrl, workspaceId }))
        .catch(() => undefined)
      const status = current?.status ?? created.status
      if (isProvisionStep(status)) {
        appendProvision({
          type: "provision",
          workspaceId,
          step: status,
          ts: Date.now(),
        }, created.directory)
      }
    } catch (error) {
      unsub?.()
      setError(error instanceof Error ? error.message : "Failed to create project")
    }
  }

  return (
    <Dialog title="New Cloud Project">
      <div class="p-4 min-w-[400px]">
        <Switch>
          <Match when={phase() === "form"}>
            <form onSubmit={handleSubmit} class="space-y-4">
              <div>
                <label class="block text-sm text-text-weak mb-1">
                  Sandbox Provider
                </label>
                <select
                  value={provider()}
                  onInput={(e) => setProvider(e.currentTarget.value)}
                  class="w-full px-3 py-2 bg-surface-inset-base border border-border-base rounded-lg text-text-strong focus:outline-none focus:border-border-interactive-base"
                >
                  <For each={providers()}>
                    {(item) => (
                      <option value={item.id} disabled={!item.configured}>
                        {item.label}{item.configured ? "" : " (configure in Settings)"}
                      </option>
                    )}
                  </For>
                </select>
                <div class="mt-2 flex flex-col gap-0.5 text-12-regular text-text-weak">
                  <span>{sandboxProviderFacts(provider()).cost}</span>
                  <span>Needs: {sandboxProviderFacts(provider()).needs}</span>
                  <Show when={sandboxProviderFacts(provider()).keyUrl}>
                    {(url) => (
                      <a class="text-12-medium text-text-interactive-base" href={url()} target="_blank" rel="noreferrer">
                        Open provider key page (setup stays here)
                      </a>
                    )}
                  </Show>
                </div>
              </div>

              <div>
                <Show when={repositories().length > 0}>
                  <label class="block text-sm text-text-weak mb-1">
                    Connected GitHub repository
                  </label>
                  <input
                    type="search"
                    value={repositorySearch()}
                    onInput={(event) => setRepositorySearch(event.currentTarget.value)}
                    placeholder="Filter repositories"
                    class="mb-2 w-full px-3 py-2 bg-surface-inset-base border border-border-base rounded-lg text-text-strong focus:outline-none focus:border-border-interactive-base"
                  />
                  <select
                    value={repository()?.id ?? ""}
                    onInput={(event) => {
                      setRepository(repositories().find((item) => item.id === event.currentTarget.value))
                      if (event.currentTarget.value) setRepoUrl("")
                    }}
                    class="w-full px-3 py-2 bg-surface-inset-base border border-border-base rounded-lg text-text-strong focus:outline-none focus:border-border-interactive-base"
                  >
                    <option value="">Choose a connected repository</option>
                    <For each={filteredRepositories()}>
                      {(item) => <option value={item.id}>{item.fullName}</option>}
                    </For>
                  </select>
                  <Show when={repository()}>
                    {(item) => (
                      <div class="mt-1 text-11-regular text-text-weak">
                        read {item().permissions.read ? "✓" : "✗"} · write {item().permissions.write ? "✓" : "✗"}
                        <Show when={!item().permissions.write}> · read-only; use a token with repository write access to open PRs</Show>
                      </div>
                    )}
                  </Show>
                  <div class="my-3 text-center text-11-regular text-text-weak">or use a public URL</div>
                </Show>
                <label class="block text-sm text-text-weak mb-1">
                  Git Repository URL
                </label>
                <input
                  type="text"
                  value={repoUrl()}
                  onInput={(e) => {
                    setRepoUrl(e.currentTarget.value)
                    if (e.currentTarget.value) setRepository(undefined)
                  }}
                  placeholder="https://github.com/username/repo"
                  class="w-full px-3 py-2 bg-surface-inset-base border border-border-base rounded-lg text-text-strong focus:outline-none focus:border-border-interactive-base"
                  autofocus
                />
                <button
                  type="button"
                  class="mt-2 text-12-medium text-text-interactive-base"
                  onClick={() => {
                    setRepository(undefined)
                    setRepoUrl("https://github.com/kyashrathore/Claxedo.git")
                  }}
                >
                  Try the example public repository
                </button>
              </div>

              <div class="flex justify-end gap-2 mt-6">
                <Button type="submit" disabled={(!repoUrl() && !repository()) || !provider()}>
                  Clone & Open
                </Button>
              </div>
            </form>
          </Match>

          <Match when={phase() === "provisioning"}>
            <div class="space-y-3">
              <div class="text-sm text-text-weak mb-2">
                Provisioning cloud workspace...
              </div>

              <div class="flex flex-col gap-2 text-xs">
                <For each={PROVISION_PIPELINE}>
                  {(pipelineStep, i) => {
                    const state = () => pipelineStepState(pipelineStep.key, i())
                    const duration = () => pipelineStepDuration(pipelineStep.key)
                    return (
                      <div class="flex items-center gap-2">
                        <Show when={state() === "active"} fallback={
                          <Show when={state() === "error"} fallback={
                            <Icon name="circle-check" size="small" class="shrink-0" classList={{
                              "text-text-on-success-base": state() === "done",
                              "text-text-weaker/20": state() === "pending",
                            }} />
                          }>
                            <Icon name="circle-ban-sign" size="small" class="text-text-on-critical-base shrink-0" />
                          </Show>
                        }>
                          <span class="inline-flex items-center justify-center size-4 shrink-0">
                            <span
                              class="size-3 rounded-full border-[1.5px] border-dashed border-border-interactive-base animate-spin"
                              style={{ "animation-duration": "3s" }}
                            />
                          </span>
                        </Show>
                        <span class="truncate flex-1" classList={{
                          "text-text-base": state() === "active",
                          "text-text-weak": state() === "done",
                          "text-text-weaker/40": state() === "pending",
                          "text-text-on-critical-base": state() === "error",
                        }}>
                          {pipelineStep.label}
                        </span>
                        <Show when={state() === "done" && duration()}>
                          <span class="text-text-weaker tabular-nums shrink-0">{duration()}s</span>
                        </Show>
                      </div>
                    )
                  }}
                </For>
                <Show when={isReady()}>
                  <div class="flex items-center gap-2">
                    <Icon name="circle-check" size="small" class="text-text-on-success-base shrink-0" />
                    <span class="text-text-on-success-base flex-1">Ready</span>
                    <Show when={totalElapsed()}>
                      <span class="text-text-on-success-base/60 tabular-nums shrink-0">{totalElapsed()}s</span>
                    </Show>
                  </div>
                </Show>
                <Show when={isRedirecting()}>
                  <div class="flex items-center gap-2">
                    <span class="inline-flex items-center justify-center size-4 shrink-0">
                      <span
                        class="size-3 rounded-full border-[1.5px] border-dashed border-border-interactive-base animate-spin"
                        style={{ "animation-duration": "3s" }}
                      />
                    </span>
                    <span class="text-text-interactive-base flex-1">Redirecting to new session...</span>
                  </div>
                </Show>
              </div>

              <Show when={error()}>
                <div class="flex items-start gap-2 mt-2 px-3 py-2 rounded bg-surface-critical-base/10 border border-border-critical-base/20">
                  <Icon name="warning" size="small" class="text-text-on-critical-base mt-0.5 shrink-0" />
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-12-medium text-text-on-critical-base">{failure()?.title}</span>
                    <span class="text-xs text-text-on-critical-base break-words">{failure()?.guidance}</span>
                    <span class="text-11-regular text-text-weak/60">Provider response: {error()}</span>
                  </div>
                </div>
                <div class="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" onClick={() => { setPhase("form"); setError("") }}>
                    {failure()?.action}
                  </Button>
                </div>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
