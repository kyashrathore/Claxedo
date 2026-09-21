import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { LocalDiagnostics } from "@/features/processes/data/local-diagnostics"

export function ActionControls(props: {
  ownerId: string
  eligibility: LocalDiagnostics.ActionEligibility
  busy?: string
  onAction(ownerId: string, action: LocalDiagnostics.ActionKind, grant: LocalDiagnostics.ActionGrant): Promise<void>
}) {
  return (
    <Show
      when={props.eligibility.state === "eligible" ? props.eligibility : undefined}
      fallback={
        <span class="text-xs text-text-weak">
          Read only · {props.eligibility.state === "ineligible" ? props.eligibility.reason : "unregistered-owner"}
        </span>
      }
    >
      {(eligibility) => (
        <div class="flex items-center gap-1">
          <For each={eligibility().actions}>
            {(grant) => (
              <Button
                variant="ghost"
                size="small"
                disabled={props.busy === `${props.ownerId}:${grant.action}`}
                onClick={() => void props.onAction(props.ownerId, grant.action, grant)}
              >
                {grant.action === "stop" ? "Stop gracefully" : "Kill owned tree"}
              </Button>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

/**
 * A stop the owner could not prove. It keeps the owner's own controls in place
 * and adds a retry, because the resources are still held: a second attempt has
 * something left to reach, unlike a retry after a clean exit.
 */
export function UnresolvedNotice(props: {
  ownerId: string
  eligibility: LocalDiagnostics.ActionEligibility
  unresolved: LocalDiagnostics.UnresolvedAction | undefined
  busy?: string
  onRetry(ownerId: string, action: LocalDiagnostics.ActionKind, grant: LocalDiagnostics.ActionGrant): Promise<void>
}) {
  const grant = () => {
    const unresolved = props.unresolved
    if (!unresolved || props.eligibility.state !== "eligible") return undefined
    return props.eligibility.actions.find((offer) => offer.action === unresolved.action)
  }
  return (
    <Show when={props.unresolved}>
      {(unresolved) => (
        <div
          role="status"
          class="mt-2 rounded border border-border-weak-base px-2 py-1.5 text-xs text-text-base"
        >
          <p>{unresolvedReading(unresolved().action, unresolved().retirement)}</p>
          <Show
            when={grant()}
            fallback={<p class="mt-1 text-text-weak">This owner no longer offers that action.</p>}
          >
            {(offer) => (
              <Button
                class="mt-1"
                variant="ghost"
                size="small"
                disabled={props.busy === `${props.ownerId}:${unresolved().action}`}
                onClick={() => void props.onRetry(props.ownerId, unresolved().action, offer())}
              >
                Retry
              </Button>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Names the half that is unproven, so a person knows what a retry would reach. */
export function unresolvedReading(action: LocalDiagnostics.ActionKind, retirement: LocalDiagnostics.Retirement) {
  const unproven = [
    retirement.leader === "alive"
      ? "the process is still running"
      : retirement.leader === "unknown"
        ? "whether the process exited is unknown"
        : undefined,
    retirement.descendants === "owned"
      ? "it still owns processes it started"
      : retirement.descendants === "unknown"
        ? "whether the processes it started are gone is unknown"
        : undefined,
  ].filter((clause) => clause !== undefined)
  return `${action === "stop" ? "Stop" : "Kill"} was accepted but could not be verified: ${
    unproven.length > 0 ? unproven.join(", and ") : "nothing confirmed it is gone"
  }. The owner kept it, so its port and terminal are still held. Retry to try again.`
}
