import type { JSX } from "solid-js"
import { Icon } from "@/ui"
import { useTranscriptI18n } from "./i18n"

export function AgentMessageEvent(props: { sender: string; children: JSX.Element }) {
  const i18n = useTranscriptI18n()
  return (
    <details data-component="agent-message-notice">
      <summary>
        <Icon name="speech-bubble" size="small" />
        <span>{i18n.t("transcript.notice.agentMessage", { sender: props.sender })}</span>
        <span data-slot="agent-message-chevron"><Icon name="chevron-right" size="small" /></span>
      </summary>
      <div>{props.children}</div>
    </details>
  )
}
