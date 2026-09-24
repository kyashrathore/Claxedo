import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { TerminalAgentStatus } from "@/server"
import { dictionary, type TerminalKey } from "../i18n"

const LABEL: Record<TerminalAgentStatus, TerminalKey> = {
  working: "terminal.agent.working",
  idle: "terminal.agent.idle",
  waitingOnUser: "terminal.agent.waitingOnUser",
  failed: "terminal.agent.failed",
}

const DOT: Record<TerminalAgentStatus, string> = {
  working: "bg-icon-accent animate-pulse",
  idle: "bg-icon-muted",
  waitingOnUser: "bg-warning-fg",
  failed: "bg-danger-fg",
}

export function AgentBadge(props: { readonly status: TerminalAgentStatus | undefined }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <Show when={props.status}>
      {(status) => (
        <span
          role="status"
          data-testid="terminal-agent-status"
          data-agent-status={status()}
          class="inline-flex items-center gap-1.5 rounded-pill border border-border-muted bg-background-base px-2 py-0.5 text-xs text-text-muted"
        >
          <span aria-hidden="true" class={`size-1.5 rounded-pill ${DOT[status()]}`} />
          {t(LABEL[status()])}
        </span>
      )}
    </Show>
  )
}
