import { Show } from "solid-js"
import type { TerminalAgentStatus } from "@/server"
import { t } from "../i18n"

const LABEL: Record<TerminalAgentStatus, () => string> = {
  working: () => t("terminal.agent.working"),
  idle: () => t("terminal.agent.idle"),
  waitingOnUser: () => t("terminal.agent.waitingOnUser"),
  failed: () => t("terminal.agent.failed"),
}

const DOT: Record<TerminalAgentStatus, string> = {
  working: "bg-text-interactive-base animate-pulse",
  idle: "bg-text-weak",
  waitingOnUser: "bg-surface-warning-strong",
  failed: "bg-surface-critical-strong",
}

export function AgentBadge(props: { status: TerminalAgentStatus | undefined }) {
  return (
    <Show when={props.status}>
      {(status) => (
        <span
          role="status"
          aria-label={LABEL[status()]()}
          data-agent-status={status()}
          class="inline-flex items-center gap-1.5 rounded-full border border-border-weak-base px-2 py-0.5 text-11-regular text-text-weak"
        >
          <span aria-hidden="true" class={`size-1.5 rounded-full ${DOT[status()]}`} />
          {LABEL[status()]()}
        </span>
      )}
    </Show>
  )
}
