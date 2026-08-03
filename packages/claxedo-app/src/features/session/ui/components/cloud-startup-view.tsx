import { For, Match, Show, Switch, createMemo, type JSX, type ParentProps } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
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
  // Honest boot modes from the sandbox manager (`bootMode` on the
  // provisioning response): a returning workspace is restored or resumed, not
  // "prepared" — say which.
  restoring_snapshot: "Restoring workspace from snapshot",
  resuming_sandbox: "Resuming sandbox",
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

/**
 * One layout for every workspace-gate state — connecting, failed, access denied.
 *
 * They are the same pane at three moments, so they get the same column: an
 * eyebrow that names the subsystem, a title, one line of detail, whatever body
 * the state needs, and its actions. When a connect fails the copy changes and
 * nothing else moves, instead of the pane swapping a left-aligned pipeline for a
 * centred icon-and-paragraph.
 */
export function WorkspaceStateShell(
  props: ParentProps<{
    component: string
    testId: string
    eyebrow: string
    title: string
    detail?: string
    tone?: "neutral" | "critical"
    /** Right-aligned trailing chip on the title row (elapsed time). */
    aside?: JSX.Element
    actions?: JSX.Element
  }>,
) {
  const critical = () => props.tone === "critical"
  return (
    <div
      data-component={props.component}
      data-testid={props.testId}
      class="flex size-full items-center justify-center px-6 py-10"
    >
      <div class="w-full max-w-[440px] text-left">
        <div class="flex items-center gap-2 text-[11px] font-medium text-text-weaker">
          <span
            classList={{
              // Monochrome by design: a settled (failed) state holds still, a live
              // one breathes. Motion carries the difference so the pane never needs
              // a second hue.
              "inline-flex size-1.5 shrink-0 rounded-full bg-text-weaker/70": true,
              "animate-pulse motion-reduce:animate-none": !critical(),
            }}
          />
          <span class="truncate">{props.eyebrow}</span>
        </div>

        <div class="mt-3 flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-[17px] font-medium leading-6 text-text-strong">{props.title}</div>
            <Show when={props.detail}>
              <div class="mt-1 text-13-regular text-text-weak">{props.detail}</div>
            </Show>
          </div>
          {props.aside}
        </div>

        {props.children}

        <Show when={props.actions}>
          <div class="mt-6 flex items-center gap-2">{props.actions}</div>
        </Show>
      </div>
    </div>
  )
}

/**
 * Shared framing for the mono detail strips: the live log and the error body.
 *
 * Deliberately un-tinted. A critical fill would put the only chroma in the pane
 * on a line of server text, and it reads as pink wash in the light themes; the
 * icon and the copy carry the severity instead.
 */
export function WorkspaceStateNote(props: ParentProps<{ tone?: "neutral" | "critical" }>) {
  return (
    <div class="mt-5 flex items-start gap-2 rounded-md border border-border-weak-base/45 bg-surface-base/35 px-3 py-2">
      {props.children}
    </div>
  )
}

/**
 * The gate's action button. It defers to the kit's `Button` rather than hand-rolling
 * one: the pane is otherwise monochrome, and `--surface-interactive-base` is a
 * saturated brand blue that would be the only chroma on the screen.
 */
export function WorkspaceStateButton(
  props: ParentProps<{ onClick: () => void; variant?: "primary" | "secondary"; testId?: string }>,
) {
  return (
    <Button
      variant={props.variant ?? "primary"}
      data-testid={props.testId}
      onClick={() => props.onClick()}
    >
      {props.children}
    </Button>
  )
}

// BUG-9: Terminal "you don't have access to this workspace" state. Rendered in
// place of the connecting pipeline when the connection mint returns 403, so the
// user sees a clean access-denied message instead of an endless "waiting for the
// workspace host" spinner.
export function WorkspaceAccessDeniedView(props: { onGoToWorkspaces?: () => void }) {
  return (
    <WorkspaceStateShell
      component="workspace-access-denied"
      testId="workspace-access-denied"
      tone="critical"
      eyebrow="Workspace access"
      title="You don't have access to this workspace"
      detail="This workspace belongs to another account, or your access was removed. Switch to a workspace you own to continue."
      actions={
        <Show when={props.onGoToWorkspaces}>
          <WorkspaceStateButton onClick={() => props.onGoToWorkspaces?.()}>
            Go to your workspaces
          </WorkspaceStateButton>
        </Show>
      }
    />
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

  // The pipeline already names the step, the title already names the phase, and
  // the log strip already streams the detail — so the summary line says the one
  // thing none of them do: what the user is waiting FOR. The old build repeated
  // the active step in the eyebrow, the summary, and a second "composer will
  // unlock" strip below the log, which read as four restatements of one fact.
  const detail = () => {
    if (hasError()) return cloudSummary(props.status, true, variant())
    if (handoffActive()) return cloudSummary(props.status, false, variant())
    return "The composer unlocks when the runtime is ready."
  }

  return (
    <Show
      when={!props.forbidden}
      fallback={<WorkspaceAccessDeniedView onGoToWorkspaces={props.onGoToWorkspaces} />}
    >
      <WorkspaceStateShell
        component="cloud-startup-view"
        testId="cloud-startup-view"
        tone={hasError() ? "critical" : "neutral"}
        eyebrow="Workspace runtime"
        title={isUserHosted() ? "Connecting to workspace" : "Preparing workspace"}
        detail={detail()}
        aside={
          <Show when={elapsed()}>
            <span class="shrink-0 rounded-md border border-border-weak-base/50 px-2 py-1 text-[11px] tabular-nums text-text-weaker">
              {elapsed()}s
            </span>
          </Show>
        }
      >
        <div class="mt-6 flex flex-col text-[13px]">
          <For each={pipeline()}>
            {(step, i) => {
              const state = () => stepState(i())
              const duration = () => stepDuration(step.key)
              const notLast = () => i() < pipeline().length - 1 || isReady()
              return (
                <StepRow connector={notLast()} state={state()}>
                  <span
                    class="truncate"
                    classList={{
                      "text-text-base": state() === "active",
                      "text-text-weak": state() === "done",
                      "text-text-weaker/40": state() === "pending",
                      "text-text-strong": state() === "error",
                    }}
                  >
                    {step.label}
                  </span>
                  <Show when={state() === "done" && duration()}>
                    <span class="text-[11px] tabular-nums text-text-weaker">{duration()}s</span>
                  </Show>
                </StepRow>
              )
            }}
          </For>
          <Show when={isReady()}>
            <StepRow connector={false} state="done">
              <span class="text-text-on-success-base">Ready</span>
              <Show when={totalElapsed()}>
                <span class="text-[11px] tabular-nums text-text-on-success-base/70">{totalElapsed()}s</span>
              </Show>
            </StepRow>
          </Show>
        </div>

        {/* Only once there is something to stream — the old placeholder line
            ("Waiting for workspace events...") gave the box weight while saying
            nothing the pipeline above had not already said. */}
        <Show when={props.logs.length > 0}>
          <WorkspaceStateNote>
            <span class="mt-1 size-1.5 shrink-0 rounded-full bg-text-weaker/70 animate-pulse motion-reduce:animate-none" />
            <span class="min-w-0 truncate font-mono text-[11px] leading-5 text-text-weak">{latestLog()}</span>
          </WorkspaceStateNote>
        </Show>

        <Show when={cleaned()}>
          <WorkspaceStateNote tone="critical">
            <Icon name="warning" size="small" class="mt-0.5 shrink-0 text-icon-base" />
            <span class="min-w-0 break-words font-mono text-[11px] leading-5 text-text-strong">{cleaned()}</span>
          </WorkspaceStateNote>
        </Show>
      </WorkspaceStateShell>
    </Show>
  )
}

/**
 * One pipeline row: indicator, label, trailing duration, and the rail that joins
 * it to the next indicator.
 *
 * The rail is positioned off the row box (h-5 indicator + py-2) rather than a
 * hand-tuned offset, so it stays joined if the row's padding ever changes.
 */
function StepRow(props: ParentProps<{ state: StepState; connector: boolean }>) {
  return (
    <div class="relative grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 py-2">
      <Show when={props.connector}>
        <span class="absolute left-[9.5px] top-7 h-4 w-px bg-border-weak-base/45" aria-hidden="true" />
      </Show>
      <span class="relative z-10 flex size-5 items-center justify-center">
        <Switch
          fallback={<span class="size-1.5 rounded-full bg-text-weaker/35" />}
        >
          <Match when={props.state === "active"}>
            {/* The old indicator was an 8px ring with a 1px transparent top edge:
                it really was spinning, but the moving gap was a single pixel of
                arc, so it read as a static circle. A 14px ring with a 2px stroke
                and a full-contrast leading edge reads as motion. */}
            <span
              class="size-3.5 rounded-full border-2 border-border-base border-t-text-base animate-spin motion-reduce:animate-none"
              style={{ "animation-duration": "0.7s" }}
            />
          </Match>
          <Match when={props.state === "error"}>
            <Icon name="warning" size="small" class="text-icon-base" />
          </Match>
          <Match when={props.state === "done"}>
            <Icon name="check-small" size="small" class="text-text-on-success-base" />
          </Match>
        </Switch>
      </span>
      {props.children}
    </div>
  )
}
