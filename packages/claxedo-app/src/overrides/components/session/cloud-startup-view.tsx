import { For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ClaxedoLogo } from "@claxedo/claxedo-ui/components/claxedo-logo"

export type CloudLog = {
  step: string
  message?: string
  ts: number
  totalMs?: number
}

type StepState = "done" | "active" | "pending" | "error"

export const CLOUD_STARTUP_PIPELINE = [
  { key: "acquiring_sandbox", label: "Acquiring sandbox" },
  { key: "cloning", label: "Cloning repository" },
  { key: "uploading_runtime", label: "Uploading runtime" },
  { key: "starting_runtime", label: "Starting runtime" },
  { key: "waiting_health", label: "Waiting for health check" },
] as const

const STEP_LABELS = {
  pending_sandbox: "Queueing sandbox",
  stopped: "Starting sandbox",
  acquiring_sandbox: "Acquiring sandbox",
  cloning: "Cloning repository",
  installing_runtime: "Installing runtime",
  uploading_runtime: "Uploading runtime",
  starting_runtime: "Starting runtime",
  waiting_health: "Waiting for health check",
  ready: "Runtime ready",
  error: "Startup failed",
} as const satisfies Record<string, string>

export function cloudStep(step?: string | null) {
  if (!step) return "Preparing workspace"
  return STEP_LABELS[step as keyof typeof STEP_LABELS] ?? step.replaceAll("_", " ")
}

export function cloudSummary(status: string | null | undefined, hasError: boolean) {
  if (hasError) return "Runtime startup failed. Review the logs below."
  if (!status) return "Checking cloud runtime before opening the composer."
  if (status === "ready") return "Runtime is ready. Finishing workspace sync."
  return `${cloudStep(status)}. Composer will appear when the workspace is ready.`
}

// The server sometimes wraps errors as JSON `{ error, detail, workspaceId, directory }`;
// show the human-readable bits and drop internal identifiers.
export function cleanCloudError(err?: string): string | undefined {
  if (!err) return undefined
  const trimmed = err.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object") {
      const detail = typeof parsed.detail === "string" ? parsed.detail : undefined
      const error = typeof parsed.error === "string" ? parsed.error : undefined
      if (detail && error) return `${error}: ${detail}`
      return detail ?? error ?? trimmed
    }
  } catch {
    // not JSON, fall through
  }
  return trimmed
}

export function cloudTotalElapsed(logs: CloudLog[]) {
  const ready = logs.find((l) => l.step === "ready")
  if (!ready || logs.length < 2) return undefined
  return ((ready.ts - logs[0].ts) / 1000).toFixed(1)
}

export function CloudStartupView(props: {
  status?: string | null
  logs: CloudLog[]
  err?: string
}) {
  const hasError = () => props.status === "error" || !!props.err
  const isReady = () => props.logs.some((l) => l.step === "ready")

  const lastPipelineKey = () => {
    const logs = props.logs
    for (let i = logs.length - 1; i >= 0; i--) {
      const step = logs[i].step
      if (step === "ready" || step === "error") continue
      return step
    }
    return null
  }

  const lastPipelineIndex = () => {
    const key = lastPipelineKey()
    if (!key) return -1
    return CLOUD_STARTUP_PIPELINE.findIndex((p) => p.key === key)
  }

  const stepState = (idx: number): StepState => {
    if (isReady()) return "done"
    const lastIdx = lastPipelineIndex()
    if (lastIdx === -1) {
      // No pipeline log yet — first step is active, rest pending.
      if (hasError() && idx === 0) return "error"
      return idx === 0 ? "active" : "pending"
    }
    if (idx < lastIdx) return "done"
    if (idx === lastIdx) return hasError() ? "error" : "active"
    return "pending"
  }

  const stepDuration = (key: string) => {
    const logs = props.logs
    const idx = logs.findIndex((l) => l.step === key)
    if (idx === -1) return undefined
    const next = logs[idx + 1]
    if (!next) return undefined
    return ((next.ts - logs[idx].ts) / 1000).toFixed(1)
  }

  const totalElapsed = () => {
    return cloudTotalElapsed(props.logs)
  }

  const cleaned = createMemo(() => cleanCloudError(props.err))

  return (
    <div class="w-full max-w-120 flex flex-col gap-6 text-left">
      <div class="flex flex-col items-center gap-4 text-center">
        <Show
          when={!hasError() && !isReady()}
          fallback={<ClaxedoLogo class="w-10" />}
        >
          <span class="inline-flex items-center justify-center size-10">
            <span
              class="size-8 rounded-full border-[1.5px] border-dashed border-border-interactive-base animate-spin"
              style={{ "animation-duration": "3s" }}
            />
          </span>
        </Show>
        <div class="text-20-medium text-text-strong">Preparing cloud workspace</div>
        <div class="max-w-100 text-13-regular text-text-weak">
          {cloudSummary(props.status, hasError())}
        </div>
      </div>

      <div class="flex flex-col gap-2 text-xs">
        <For each={CLOUD_STARTUP_PIPELINE}>
          {(step, i) => {
            const state = () => stepState(i())
            const duration = () => stepDuration(step.key)
            return (
              <div class="flex items-center gap-2">
                <Show
                  when={state() === "active"}
                  fallback={
                    <Show
                      when={state() === "error"}
                      fallback={
                        <Icon
                          name="circle-check"
                          size="small"
                          class="shrink-0"
                          classList={{
                            "text-text-on-success-base": state() === "done",
                            "text-text-weaker/20": state() === "pending",
                          }}
                        />
                      }
                    >
                      <Icon name="circle-ban-sign" size="small" class="text-text-on-critical-base shrink-0" />
                    </Show>
                  }
                >
                  <span class="inline-flex items-center justify-center size-4 shrink-0">
                    <span
                      class="size-3 rounded-full border-[1.5px] border-dashed border-border-interactive-base animate-spin"
                      style={{ "animation-duration": "3s" }}
                    />
                  </span>
                </Show>
                <span
                  class="truncate flex-1"
                  classList={{
                    "text-text-base": state() === "active",
                    "text-text-weak": state() === "done",
                    "text-text-weaker/40": state() === "pending",
                    "text-text-on-critical-base": state() === "error",
                  }}
                >
                  {step.label}
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
      </div>

      <Show when={cleaned()}>
        <div class="flex items-start gap-2 px-3 py-2 rounded-md bg-surface-critical-base/8 border border-border-critical-base/20">
          <Icon name="warning" size="small" class="text-text-on-critical-base mt-0.5 shrink-0" />
          <span class="text-12-regular text-text-on-critical-base break-words min-w-0">{cleaned()}</span>
        </div>
      </Show>
    </div>
  )
}
