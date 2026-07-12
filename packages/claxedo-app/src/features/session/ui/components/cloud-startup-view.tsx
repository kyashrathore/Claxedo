import { For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { WorkspaceRuntimeLog } from "@/platform/runtime/workspace-log"
export type CloudLog = WorkspaceRuntimeLog

type StepState = "done" | "active" | "pending" | "error"

export type StartupVariant = "cloud" | "user-hosted"

export const CLOUD_STARTUP_PIPELINE = [
  { key: "acquiring_sandbox", label: "Acquiring sandbox" },
  { key: "cloning", label: "Cloning repository" },
  { key: "starting_runtime", label: "Starting runtime" },
  { key: "waiting_health", label: "Waiting for health check" },
] as const

// User-hosted workspaces never acquire a sandbox or clone a repo — they already
// exist on the user's machine and connect through the relay tunnel. Their
// connecting sequence is mint-connection → relay-tunnel → runtime-health.
export const USER_HOSTED_STARTUP_PIPELINE = [
  { key: "connecting_workspace", label: "Connecting to workspace" },
  { key: "establishing_relay", label: "Establishing relay tunnel" },
  { key: "checking_health", label: "Checking runtime health" },
] as const

export function startupPipeline(variant: StartupVariant) {
  return variant === "user-hosted" ? USER_HOSTED_STARTUP_PIPELINE : CLOUD_STARTUP_PIPELINE
}

const STEP_LABELS = {
  stopped: "Starting sandbox",
  acquiring_sandbox: "Acquiring sandbox",
  cloning: "Cloning repository",
  starting_runtime: "Starting runtime",
  waiting_health: "Waiting for health check",
  connecting_workspace: "Connecting to workspace",
  establishing_relay: "Establishing relay tunnel",
  checking_health: "Checking runtime health",
  ready: "Runtime ready",
  syncing_workspace: "Syncing workspace",
  loading_models: "Loading models",
  creating_session: "Creating session",
  opening_session: "Opening session",
  sending_prompt: "Sending first message",
  error: "Startup failed",
} as const satisfies Record<string, string>

function isKnownCloudStep(step: string): step is keyof typeof STEP_LABELS {
  return Object.hasOwn(STEP_LABELS, step)
}

export function cloudStep(step?: string | null) {
  if (!step) return "Preparing workspace"
  if (isKnownCloudStep(step)) return STEP_LABELS[step]
  return step.replaceAll("_", " ")
}

export function cloudSummary(status: string | null | undefined, hasError: boolean, variant: StartupVariant = "cloud") {
  if (hasError) {
    return variant === "user-hosted"
      ? "Could not connect to the workspace. Review the details below."
      : "Workspace startup failed. Review the log below."
  }
  if (!status) {
    return variant === "user-hosted"
      ? "Connecting to your workspace before the composer unlocks."
      : "Checking runtime before the composer unlocks."
  }
  if (status === "ready") return "Runtime is ready. Preparing the session."
  if (status === "syncing_workspace") return "Runtime is ready. Syncing the workspace."
  if (status === "loading_models") return "Runtime is ready. Loading available models."
  if (status === "creating_session") return "Runtime is ready. Creating the session."
  if (status === "opening_session") return "Session is ready. Opening it now."
  if (status === "sending_prompt") return "Sending the first message."
  return `${cloudStep(status)} before the composer unlocks.`
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

// BUG-9: A 403 from the connection mint is terminal ("not your workspace"), not
// a transient connecting state. The relay-request layer surfaces it as a
// `Workspace connection failed: 403` body / `Runtime health check failed (403)`
// status. Detect that so the gate can branch to an access-denied view instead of
// spinning in the "waiting for host" pipeline.
export function isForbiddenConnectionError(err?: string | null): boolean {
  if (!err) return false
  return /\b403\b/.test(err) || /forbidden/i.test(err)
}

export function cloudTotalElapsed(logs: CloudLog[]) {
  const ready = logs.find((l) => l.step === "ready")
  if (!ready || logs.length < 2) return undefined
  return ((ready.ts - logs[0].ts) / 1000).toFixed(1)
}

function cloudElapsed(logs: CloudLog[]) {
  if (logs.length < 2) return undefined
  return ((logs[logs.length - 1].ts - logs[0].ts) / 1000).toFixed(1)
}

// BUG-9: Terminal "you don't have access to this workspace" state. Rendered in
// place of the connecting pipeline when the connection mint returns 403, so the
// user sees a clean access-denied message instead of an endless "waiting for the
// workspace host" spinner.
export function WorkspaceAccessDeniedView(props: { onGoToWorkspaces?: () => void }) {
  return (
    <div data-component="workspace-access-denied" data-testid="workspace-access-denied" class="w-full max-w-[520px] text-left">
      <div class="flex items-center gap-2 text-[11px] font-medium text-text-weaker">
        <span class="inline-flex size-2 rounded-full bg-text-on-critical-base/60" />
        <span>Workspace access</span>
      </div>
      <div class="mt-3 flex items-start gap-3">
        <Icon name="warning" size="medium" class="text-text-on-critical-base mt-0.5 shrink-0" />
        <div class="min-w-0">
          <div class="text-[18px] font-medium leading-6 text-text-strong">
            You don't have access to this workspace
          </div>
          <div class="mt-1 max-w-[420px] text-13-regular text-text-weak">
            This workspace belongs to another account, or your access was removed. Switch to a
            workspace you own to continue.
          </div>
        </div>
      </div>
      <Show when={props.onGoToWorkspaces}>
        <div class="mt-5">
          <button
            type="button"
            class="inline-flex h-8 items-center rounded-md border border-border-weak-base/55 bg-background-base px-3 text-12-regular text-text-base hover:bg-surface-base-hover/40"
            onClick={() => props.onGoToWorkspaces?.()}
          >
            Go to your workspaces
          </button>
        </div>
      </Show>
    </div>
  )
}

export function CloudStartupView(props: {
  status?: string | null
  logs: CloudLog[]
  err?: string
  /** Defaults to the cloud sandbox-acquisition pipeline. */
  variant?: StartupVariant
  /** BUG-9: when set, render the terminal access-denied state instead of the pipeline. */
  forbidden?: boolean
  onGoToWorkspaces?: () => void
}) {
  const variant = () => props.variant ?? "cloud"
  const pipeline = () => startupPipeline(variant())
  const hasError = () => props.status === "error" || !!props.err
  const isReady = () => props.logs.some((l) => l.step === "ready")
  const isUserHosted = () => variant() === "user-hosted"

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
    return pipeline().findIndex((p) => p.key === key)
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
  const handoffActive = () => isReady() && !hasError() && props.status !== "ready"
  const latestLog = createMemo(() => {
    const last = props.logs.at(-1)
    if (!last) return "Waiting for workspace events..."
    return last.message || cloudStep(last.step)
  })
  const elapsed = createMemo(() => totalElapsed() ?? cloudElapsed(props.logs))

  return (
    <Show
      when={!props.forbidden}
      fallback={<WorkspaceAccessDeniedView onGoToWorkspaces={props.onGoToWorkspaces} />}
    >
    <div data-component="cloud-startup-view" class="flex size-full items-center justify-center px-6 py-10">
    <div class="w-full max-w-[520px] text-left">
      <div class="flex items-center gap-2 text-[11px] font-medium text-text-weaker">
        <span class="inline-flex size-2 rounded-full bg-text-weaker/50" />
        <span>Workspace runtime</span>
        <span class="text-text-weaker/40">/</span>
        <span class="truncate">{cloudStep(props.status)}</span>
      </div>

      <div class="mt-3 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="text-[18px] font-medium leading-6 text-text-strong">
            {isUserHosted() ? "Connecting to workspace" : "Preparing workspace"}
          </div>
          <div class="mt-1 max-w-[420px] text-13-regular text-text-weak">
            {cloudSummary(props.status, hasError(), variant())}
          </div>
        </div>
        <Show when={elapsed()}>
          <span class="shrink-0 rounded-md border border-border-weak-base/50 px-2 py-1 text-[11px] tabular-nums text-text-weaker">
            {elapsed()}s
          </span>
        </Show>
      </div>

      <div class="mt-6 flex flex-col gap-0 text-[13px]">
        <For each={pipeline()}>
          {(step, i) => {
            const state = () => stepState(i())
            const duration = () => stepDuration(step.key)
            const notLast = () => i() < pipeline().length - 1
            return (
              <div class="relative grid grid-cols-[18px_minmax(0,1fr)_auto] gap-3 py-1.5">
                <Show when={notLast()}>
                  <span class="absolute left-[8px] top-[22px] h-[18px] w-px bg-border-weak-base/45" />
                </Show>
                <span class="relative z-10 flex size-[18px] items-center justify-center">
                  <Show
                    when={state() === "active"}
                    fallback={
                      <Show
                        when={state() === "error"}
                        fallback={
                          <Show
                            when={state() === "done"}
                            fallback={<span class="size-2 rounded-full border border-border-weak-base/55 bg-background-base" />}
                          >
                            <Icon name="check-small" size="small" class="text-text-on-success-base" />
                          </Show>
                        }
                      >
                        <Icon name="warning" size="small" class="text-text-on-critical-base" />
                      </Show>
                    }
                  >
                    <span class="inline-flex items-center justify-center size-4 rounded-full border border-border-base bg-background-base">
                      <span
                        class="size-2 rounded-full border border-border-base border-t-transparent animate-spin"
                        style={{ "animation-duration": "1.4s" }}
                      />
                    </span>
                  </Show>
                </span>
                <span
                  class="truncate"
                  classList={{
                    "text-text-base": state() === "active",
                    "text-text-weak": state() === "done",
                    "text-text-weaker/35": state() === "pending",
                    "text-text-on-critical-base": state() === "error",
                  }}
                >
                  {step.label}
                </span>
                <Show when={state() === "done" && duration()}>
                  <span class="text-[11px] tabular-nums text-text-weaker">{duration()}s</span>
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={isReady()}>
          <div class="relative grid grid-cols-[18px_minmax(0,1fr)_auto] gap-3 py-1.5">
            <span class="flex size-[18px] items-center justify-center">
              <Icon name="check-small" size="small" class="text-text-on-success-base" />
            </span>
            <span class="text-text-on-success-base">Ready</span>
            <Show when={totalElapsed()}>
              <span class="text-[11px] tabular-nums text-text-on-success-base/70">{totalElapsed()}s</span>
            </Show>
          </div>
        </Show>
      </div>

      <div class="mt-5 rounded-md border border-border-weak-base/45 bg-surface-base-hover/20 px-3 py-2">
        <div class="flex items-center gap-2 text-[11px] text-text-weaker">
          <span class="shrink-0 font-medium uppercase tracking-[0.08em] text-text-weaker/70">Live</span>
          <span class="min-w-0 truncate font-mono text-[11px] text-text-weak">{latestLog()}</span>
        </div>
      </div>

      <div class="mt-3 flex h-9 items-center gap-2 rounded-md border border-border-weak-base/35 bg-background-base/45 px-3 text-12-regular text-text-weaker">
        <Show
          when={!hasError() && (!isReady() || handoffActive())}
          fallback={<Icon name={hasError() ? "warning" : "check-small"} size="small" class={hasError() ? "text-text-on-critical-base" : "text-text-on-success-base"} />}
        >
          <span class="inline-flex size-4 items-center justify-center">
            <span
              class="size-3 rounded-full border border-border-base border-t-transparent animate-spin"
              style={{ "animation-duration": "1.4s" }}
            />
          </span>
        </Show>
        <span class="truncate">{handoffActive() ? latestLog() : "Composer will unlock when the runtime is ready."}</span>
      </div>
      <Show when={cleaned()}>
        <div class="mt-3 flex items-start gap-2 rounded-md border border-border-critical-base/20 bg-surface-critical-base/8 px-3 py-2">
          <Icon name="warning" size="small" class="text-text-on-critical-base mt-0.5 shrink-0" />
          <span class="text-12-regular text-text-on-critical-base break-words min-w-0">{cleaned()}</span>
        </div>
      </Show>
    </div>
    </div>
    </Show>
  )
}
