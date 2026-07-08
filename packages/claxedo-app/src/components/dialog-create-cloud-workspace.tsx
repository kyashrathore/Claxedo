import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { api, getDefaultBaseUrl } from "../utils/api"
import { type ClaxedoEvent, useClaxedoEventsOptional } from "../providers/claxedo-events"
import { workspaceCreateUrl, workspaceProvidersUrl, workspaceResolveUrl } from "../utils/workspace-control-routes"

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

interface CreateWorkspaceResult {
  workspaceId: string
  projectId?: string
  directory?: string
  provider?: string
  status?: string | null
}

type ProvisionEvent = Extract<ClaxedoEvent, { type: "provision" }>
type ProvisionStep = ProvisionEvent["step"]

type ProvisionLog = {
  step: string
  message?: string
  ts: number
  totalMs?: number
}

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

export interface DialogCreateCloudWorkspaceProps {
  projectId: string
  onCreated: (directory: string) => void
  onClose?: () => void
}

/**
 * Dialog for creating a cloud sandbox workspace within an existing project.
 * Provider selection with visual cards + optional workspace name.
 */
export function DialogCreateCloudWorkspace(props: DialogCreateCloudWorkspaceProps) {
  const [provider, setProvider] = createSignal("")
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [workspaceName, setWorkspaceName] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [fetching, setFetching] = createSignal(true)
  const [phase, setPhase] = createSignal<"form" | "provisioning">("form")
  const [logs, setLogs] = createSignal<ProvisionLog[]>([])
  const dialog = useDialog()
  const events = useClaxedoEventsOptional()

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
      .finally(() => setFetching(false))
  })

  const configured = () => providers().filter((p) => p.configured)
  const hasConfigured = () => configured().length > 0

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
    if (!provider()) return

    setLoading(true)
    setError("")
    setPhase("provisioning")
    setLogs([])

    const buffered: ProvisionEvent[] = []
    const seen = new Set<string>()
    let workspaceId: string | undefined
    let unsub: (() => void) | undefined

    const appendProvision = (ev: ProvisionEvent) => {
      if (ev.workspaceId !== workspaceId) return

      if (ev.step === "acquiring_sandbox" && error()) {
        setError("")
      }

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
          props.onCreated(dir)
          dialog.close()
        }, 1200)
      }

      if (ev.step === "error") {
        setError(ev.message || "Provisioning failed")
      }
    }

    if (events) {
      unsub = events.on("provision", (ev) => {
        if (!workspaceId) {
          buffered.push(ev)
          return
        }
        appendProvision(ev)
      })
      onCleanup(unsub)
    }

    let dir = ""
    try {
      const result = await api.post<CreateWorkspaceResult>(
        workspaceCreateUrl({ baseUrl }),
        {
          projectId: props.projectId,
          provider: provider(),
          workspaceName: workspaceName().trim() || undefined,
        },
      )

      dir = result.directory ?? ""
      if (!dir) throw new Error("Workspace create did not return a directory")
      workspaceId = result.workspaceId

      // If we have SSE events, show provisioning progress
      if (events) {
        for (const ev of buffered) appendProvision(ev)
        const current = await api
          .get<{ status?: string | null }>(workspaceResolveUrl({ baseUrl, workspaceId }))
          .catch(() => undefined)
        const status = current?.status ?? result.status
        if (isProvisionStep(status)) {
          appendProvision({ type: "provision", workspaceId, step: status, ts: Date.now() })
        }

        // Timeout fallback: if no ready event after 120s, navigate anyway
        const timeout = setTimeout(() => {
          unsub?.()
          props.onCreated(dir)
          dialog.close()
        }, 120_000)
        onCleanup(() => clearTimeout(timeout))
      } else {
        // No SSE — navigate immediately (fallback)
        props.onCreated(dir)
        dialog.close()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace")
      setPhase("form")
      setLoading(false)
      unsub?.()
    }
  }

  const cancel = () => {
    props.onClose?.()
    dialog.close()
  }

  return (
    <Dialog title="Cloud Workspace" fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 min-w-[400px]">
        <Show when={phase() === "form"}>
          <form onSubmit={handleSubmit} class="flex flex-col gap-4">
            {/* Provider selection */}
            <div class="flex flex-col gap-1.5">
              <label class="text-12-medium text-text-weak uppercase tracking-wider">
                Compute Provider
              </label>

              <Show
                when={!fetching()}
                fallback={
                  <div class="flex items-center justify-center py-6">
                    <span class="text-12-regular text-text-weak">Loading providers...</span>
                  </div>
                }
              >
                <div class="flex flex-col gap-1.5">
                  <For each={providers()}>
                    {(item) => (
                      <button
                        type="button"
                        class="group flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-interactive-focus"
                        classList={{
                          "border-border-interactive-base/40 bg-surface-interactive-base/6": provider() === item.id && item.configured,
                          "border-border-weak-base hover:border-border-base hover:bg-surface-raised-base": provider() !== item.id && item.configured,
                          "border-border-weak-base opacity-40 cursor-not-allowed": !item.configured,
                        }}
                        onClick={() => item.configured && setProvider(item.id)}
                        disabled={!item.configured}
                      >
                        {/* Selection indicator */}
                        <div
                          class="shrink-0 size-4 rounded-full border-2 flex items-center justify-center transition-colors"
                          classList={{
                            "border-border-interactive-base": provider() === item.id && item.configured,
                            "border-border-base": provider() !== item.id || !item.configured,
                          }}
                        >
                          <Show when={provider() === item.id && item.configured}>
                            <div class="size-2 rounded-full bg-surface-interactive-base" />
                          </Show>
                        </div>

                        <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                          <span class="text-13-medium text-text-strong">{item.label}</span>
                          <Show
                            when={item.configured}
                            fallback={
                              <span class="text-11-regular text-icon-warning-base">
                                API key not configured
                              </span>
                            }
                          >
                            <span class="text-11-regular text-text-weak">Ready</span>
                          </Show>
                        </div>

                        {/* Status dot */}
                        <div
                          class="shrink-0 size-1.5 rounded-full"
                          classList={{
                            "bg-surface-success-strong": item.configured,
                            "bg-border-base": !item.configured,
                          }}
                        />
                      </button>
                    )}
                  </For>
                </div>

                <Show when={!hasConfigured()}>
                  <p class="text-12-regular text-icon-warning-base mt-1">
                    Configure provider credentials in Settings before creating cloud workspaces.
                  </p>
                </Show>
              </Show>
            </div>

            {/* Workspace name */}
            <Show when={hasConfigured()}>
              <div class="flex flex-col gap-1.5">
                <label class="text-12-medium text-text-weak uppercase tracking-wider">
                  Name <span class="normal-case tracking-normal text-text-weak/60">(optional)</span>
                </label>
                <input
                  type="text"
                  value={workspaceName()}
                  onInput={(e) => setWorkspaceName(e.currentTarget.value)}
                  placeholder="feature-auth"
                  class="w-full bg-surface-inset-base border border-border-weak-base rounded-md px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/40 focus:outline-none focus:ring-1 focus:ring-border-interactive-focus focus:border-border-interactive-base/40 transition-colors"
                />
              </div>
            </Show>

            {/* Error */}
            <Show when={error()}>
              <div class="flex items-start gap-2 px-3 py-2 rounded-md bg-surface-critical-base/8 border border-border-critical-base/20">
                <Icon name="warning" size="small" class="text-text-on-critical-base mt-0.5 shrink-0" />
                <span class="text-12-regular text-text-on-critical-base">{error()}</span>
              </div>
            </Show>

            {/* Actions */}
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="large" onClick={cancel} type="button">
                Cancel
              </Button>
              <Button
                variant="primary"
                size="large"
                type="submit"
                disabled={loading() || !provider() || !hasConfigured()}
              >
                {loading() ? "Provisioning..." : "Create"}
              </Button>
            </div>
          </form>
        </Show>

        <Show when={phase() === "provisioning"}>
          <div class="flex flex-col gap-3">
            <p class="text-12-regular text-text-weak">Provisioning cloud workspace...</p>

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
              <div class="flex items-start gap-2 px-3 py-2 rounded-md bg-surface-critical-base/8 border border-border-critical-base/20">
                <Icon name="warning" size="small" class="text-text-on-critical-base mt-0.5 shrink-0" />
                <div class="flex flex-col gap-0.5">
                  <span class="text-12-regular text-text-on-critical-base break-words min-w-0">{error()}</span>
                  <span class="text-11-regular text-text-weak/50">Retrying automatically...</span>
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" size="large" onClick={() => { setPhase("form"); setError(""); setLoading(false) }}>
                  Back
                </Button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
