import { createSignal, Show } from "solid-js"
import type { AgentContentPart } from "@claxedo/agent-runtime-contract"
import { Icon } from "@/ui"
import { useTranscriptI18n } from "./i18n"
import { retractionLabel } from "./notice-view"

export function isRetractedPart(part: AgentContentPart): boolean {
  return (part.type === "text" || part.type === "reasoning") && part.retracted !== undefined
}

export function RetractedPartDisplay(props: { part: AgentContentPart }) {
  const i18n = useTranscriptI18n()
  const [open, setOpen] = createSignal(false)
  const withdrawn = () => (props.part.type === "text" || props.part.type === "reasoning" ? props.part : undefined)
  return (
    <Show when={withdrawn()}>
      {(part) => (
        <div data-component="retracted-part">
          <div data-slot="retracted-part-header">
            <span data-slot="notice-part-icon">
              <Icon name="circle-ban-sign" size="small" />
            </span>
            <span data-slot="notice-part-text">{i18n.t(retractionLabel(part().retracted?.reason ?? ""))}</span>
            <button type="button" data-slot="retracted-part-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
              {i18n.t(open() ? "transcript.retracted.hide" : "transcript.retracted.show")}
            </button>
          </div>
          <Show when={open()}>
            <div data-slot="retracted-part-text">{part().text}</div>
          </Show>
        </div>
      )}
    </Show>
  )
}
