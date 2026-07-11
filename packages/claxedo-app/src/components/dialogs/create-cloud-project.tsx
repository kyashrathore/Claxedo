import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { api, getDefaultBaseUrl, normalizeUrl } from "../../utils/api"
import { type ClaxedoEvent, useClaxedoEvents } from "../../context/claxedo-events"
import { workspaceCreateUrl, workspaceProvidersUrl, workspaceResolveUrl } from "../../utils/workspace-control-routes"

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
  repoUrl: string,
): Promise<CreateWorkspaceResult> {
  return api.post<CreateWorkspaceResult>(
    workspaceCreateUrl({ baseUrl }),
    {
      provider,
      projectName: name,
      workspaceName: "main",
      repoUrl,
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
  const [provider, setProvider] = createSignal("")
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [phase, setPhase] = createSignal<"form" | "provisioning">("form")
  const [logs, setLogs] = createSignal<ProvisionLog[]>([])
  const [error, setError] = createSignal("")
  const dialog = useDialog()
  const events = useClaxedoEvents()

  const baseUrl = getDefaultBaseUrl()

  createEffect(() => {
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
    if (!repoUrl() || !provider()) return

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
        unsub?.()
        setLogs((prev) => [...prev, { step: "redirecting", ts: Date.now() }])
        setTimeout(() => {
          props.onSelect(directory)
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
      const name = repoUrl().split("/").pop()?.replace(".git", "") || "Untitled"
      const created = await createCloudProject(baseUrl, provider(), name, repoUrl())

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
              </div>

              <div>
                <label class="block text-sm text-text-weak mb-1">
                  Git Repository URL
                </label>
                <input
                  type="text"
                  value={repoUrl()}
                  onInput={(e) => setRepoUrl(e.currentTarget.value)}
                  placeholder="https://github.com/username/repo"
                  class="w-full px-3 py-2 bg-surface-inset-base border border-border-base rounded-lg text-text-strong focus:outline-none focus:border-border-interactive-base"
                  autofocus
                />
              </div>

              <div class="flex justify-end gap-2 mt-6">
                <Button type="submit" disabled={!repoUrl() || !provider()}>
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
                  <span class="text-xs text-text-on-critical-base break-words min-w-0">{error()}</span>
                </div>
                <div class="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" onClick={() => { setPhase("form"); setError("") }}>
                    Back
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
