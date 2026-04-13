import { For, Show, createMemo } from "solid-js"
import { ClaxedoLogo } from "@claxedo/claxedo-ui/components/claxedo-logo"

export type CloudLog = {
  step: string
  message?: string
  ts: number
  totalMs?: number
}

const label = {
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
  return label[step as keyof typeof label] ?? step.replaceAll("_", " ")
}

function summary(step?: string | null) {
  if (!step) return "Checking cloud runtime before opening the composer."
  if (step === "ready") return "Runtime is ready. Finishing workspace sync."
  if (step === "error") return "Runtime startup failed. Review the logs below."
  return `${cloudStep(step)}. Composer will appear when the workspace is ready.`
}

export function CloudStartupView(props: {
  status?: string | null
  logs: CloudLog[]
  err?: string
}) {
  const rows = createMemo(() => {
    if (props.logs.length > 0) return props.logs
    return [{
      step: props.status ?? "pending_sandbox",
      ts: Date.now(),
    }]
  })

  return (
    <div class="w-full max-w-220 flex flex-col gap-6 text-left">
      <div class="flex flex-col items-center gap-4 text-center">
        <ClaxedoLogo class="w-10" />
        <div class="text-20-medium text-text-strong">Preparing cloud workspace</div>
        <div class="max-w-140 text-13-regular text-text-weak">
          {summary(props.status)}
        </div>
      </div>

      <div class="rounded-xl border border-border-weak bg-surface-raised/80 overflow-hidden">
        <div class="flex items-center justify-between gap-3 border-b border-border-weak px-4 py-3">
          <div class="text-11-medium uppercase tracking-[0.18em] text-text-weak">Startup Log</div>
          <div class="text-11-medium text-text-weak">{cloudStep(props.status)}</div>
        </div>

        <div class="max-h-96 overflow-auto px-4 py-3">
          <div class="flex flex-col gap-2 font-mono text-[12px] leading-5 text-text-strong">
            <For each={rows()}>
              {(item) => (
                <div class="flex items-start gap-3">
                  <div class="w-24 shrink-0 text-text-weak tabular-nums">
                    {new Date(item.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div>{cloudStep(item.step)}</div>
                    <Show when={item.message}>
                      <div class="break-words text-text-weak">{item.message}</div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      <Show when={props.err}>
        <div class="rounded-xl border border-red-500/30 bg-red-500/8 px-4 py-3 text-12-regular text-red-300">
          {props.err}
        </div>
      </Show>
    </div>
  )
}
