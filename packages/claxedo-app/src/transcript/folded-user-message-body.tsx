import { createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTranscriptI18n } from "./i18n"

export function FoldedUserMessageBody(props: { readonly markdown: boolean; readonly children: JSX.Element }) {
  const i18n = useTranscriptI18n()
  const id = createUniqueId()
  const [expanded, setExpanded] = createSignal(false)
  const [overflows, setOverflows] = createSignal(false)
  let preview!: HTMLDivElement
  let content!: HTMLDivElement

  onMount(() => {
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(preview).lineHeight)
      setOverflows(content.scrollHeight > lineHeight * 8 + 17)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    onCleanup(() => observer.disconnect())
  })

  const toggle = () => {
    const collapsing = expanded()
    setExpanded(!collapsing)
    if (collapsing) preview.scrollIntoView({ block: "nearest" })
  }

  return (
    <div class="ui-user-message-body ui-folded-user-message-body" data-markdown={props.markdown ? "true" : undefined}>
      <div
        ref={preview}
        id={id}
        class="ui-user-message-preview"
        data-expanded={expanded() || !overflows() ? "true" : undefined}
        onFocusIn={(event) => {
          if (event.target instanceof HTMLElement && event.target.getBoundingClientRect().bottom > preview.getBoundingClientRect().bottom) setExpanded(true)
        }}
      >
        <div ref={content}>{props.children}</div>
      </div>
      <Show when={overflows()}>
        <button
          type="button"
          class="ui-user-message-fold-toggle"
          aria-expanded={expanded()}
          aria-controls={id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
        >
          {expanded() ? i18n.t("transcript.scrollableOutput.showLess") : i18n.t("transcript.scrollableOutput.showAll")}
        </button>
      </Show>
    </div>
  )
}
