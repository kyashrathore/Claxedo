import { Show } from "solid-js"
import { Card } from "@opencode-ai/ui/card"
import { Spinner } from "@opencode-ai/ui/spinner"
import { SessionRetry as UpstreamSessionRetry } from "@/ui/session-kit"

type SdkSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; message: string; next: number; attempt: number }

export type SessionRecoveringStatus = {
  type: "recovering"
  kind: "process_restart"
  message: string
}

export type ClaxedoSessionStatus = SdkSessionStatus | SessionRecoveringStatus

export function ClaxedoSessionRetry(props: { status: ClaxedoSessionStatus; show?: boolean }) {
  const recovering = () => props.status.type === "recovering" ? props.status : undefined

  return (
    <Show
      when={recovering()}
      fallback={<UpstreamSessionRetry status={props.status as SdkSessionStatus} show={props.show} />}
    >
      {(status) => (
        <Show when={props.show ?? true}>
          <div data-slot="session-turn-retry">
            <Card variant="warning" class="error-card">
              <div class="flex items-start gap-2">
                <Spinner class="size-4 mt-0.5" />
                <div class="min-w-0">
                  <div data-slot="session-turn-retry-message">Recovering ACP client...</div>
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
