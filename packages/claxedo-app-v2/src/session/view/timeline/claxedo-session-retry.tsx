import { Show } from "solid-js"
import { Card, Spinner } from "@/ui"
import type { AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import type { SessionStatus } from "@/server"
import { SessionRetry as UpstreamSessionRetry } from "@/transcript"

function upstreamStatus(status: SessionStatus): AgentRuntimeStatus | undefined {
  switch (status.kind) {
    case "idle":
    case "failed":
      return { type: "idle" }
    case "working":
      return { type: "busy" }
    case "retrying":
      return {
        type: "retry",
        attempt: status.attempt,
        message: status.message,
        next: status.nextAt,
        ...("action" in status && status.action ? { action: status.action as NonNullable<Extract<AgentRuntimeStatus, { type: "retry" }>["action"]> } : {}),
      }
    case "recovering":
      return undefined
  }
}

function recoveringMessage(status: Extract<SessionStatus, { kind: "recovering" }>) {
  const uncertain = "reason" in status && status.reason === "uncertainExecution"
  return uncertain ? "Waiting for the agent to confirm cancellation..." : "Recovering ACP client..."
}

export function ClaxedoSessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const recovering = () => (props.status.kind === "recovering" ? props.status : undefined)
  const upstream = () => upstreamStatus(props.status)

  return (
    <Show
      when={recovering()}
      fallback={<Show when={upstream()}>{(status) => <UpstreamSessionRetry status={status()} show={props.show} />}</Show>}
    >
      {(status) => (
        <Show when={props.show ?? true}>
          <div data-slot="session-turn-retry">
            <Card variant="warning" class="error-card">
              <div class="flex items-start gap-2">
                <Spinner class="size-4 mt-0.5" />
                <div class="min-w-0">
                  <div data-slot="session-turn-retry-message">{recoveringMessage(status())}</div>
                  <div data-slot="session-turn-retry-info">{status().message}</div>
                </div>
              </div>
            </Card>
          </div>
        </Show>
      )}
    </Show>
  )
}
