import { Match, Switch } from "solid-js"
import type { AgentContentPart } from "@claxedo/agent-runtime-contract"
import { Icon } from "@/ui"
import { useTranscriptI18n } from "./i18n"
import { MessageDivider } from "./message-divider"
import { noticeView, type NoticeMessage, type NoticeView } from "./notice-view"

type RowView = Extract<NoticeView, { shape: "row" }>

function NoticeRow(props: { view: RowView }) {
  const i18n = useTranscriptI18n()
  const text = (message: NoticeMessage) => ("text" in message ? message.text : i18n.t(message.key, { error: message.error }))
  return (
    <div data-component="notice-part" data-tone={props.view.tone} role={props.view.tone === "info" ? "note" : "status"}>
      <span data-slot="notice-part-icon">
        <Icon name={props.view.tone === "info" ? "speech-bubble" : "circle-alert"} size="small" />
      </span>
      <span data-slot="notice-part-text">{text(props.view.message)}</span>
    </div>
  )
}

export function NoticePartDisplay(props: { part: AgentContentPart }) {
  const i18n = useTranscriptI18n()
  const view = () => (props.part.type === "notice" ? noticeView(props.part.notice) : undefined)
  const boundary = () => {
    const current = view()
    return current?.shape === "boundary" ? current : undefined
  }
  const row = () => {
    const current = view()
    return current?.shape === "row" ? current : undefined
  }
  return (
    <Switch>
      <Match when={boundary()}>{(current) => <MessageDivider label={i18n.t(current().key)} icon="archive" />}</Match>
      <Match when={row()}>{(current) => <NoticeRow view={current()} />}</Match>
    </Switch>
  )
}
